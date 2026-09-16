import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChangedFile, ChangeStatus } from '@bonsai/shared';

import { git, gitDiffNoIndex, status } from './exec.js';

/**
 * What changed, file by file, and the patch for one file at a time.
 *
 * The Changes tab used to fetch an experiment's WHOLE patch and render every
 * file as an accordion, opening the first four -- so reaching the last file of
 * a large change meant scrolling past all the others, and a thousand-file run
 * shipped a thousand files of text to show a list. A summary is counts and
 * statuses; a file's patch is fetched when someone opens that file.
 */

/**
 * The same options everywhere, so a summary and a file's patch agree about
 * renames. `core.quotepath=false` with `-z` keeps non-ASCII and spaced paths
 * as they are rather than octal-escaped and quoted.
 */
const DIFF = [
  '-c',
  'core.quotepath=false',
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--find-renames',
] as const;

/** A single file's patch beyond this is cut, and says so. */
export const MAX_PATCH_BYTES = 2 * 1024 * 1024;

/** Untracked files larger than this are listed without counting their lines. */
const MAX_COUNTED_BYTES = 10 * 1024 * 1024;

/** The agent's notes, which every run may touch and nobody reviews as code. */
export const NOTES_FILE = 'CONTEXT.md';

/** Committed changes between two commits. */
export async function committedChanges(
  worktree: string,
  base: string,
  head: string,
): Promise<ChangedFile[]> {
  const [names, counts] = await Promise.all([
    git([...DIFF, '--name-status', '-z', base, head, '--'], worktree),
    git([...DIFF, '--numstat', '-z', base, head, '--'], worktree),
  ]);
  const numbers = parseNumstat(counts);
  return sortByPath(
    parseNameStatus(names).map((entry) => ({
      ...entry,
      ...(numbers.get(entry.path) ?? { added: 0, removed: 0, binary: false }),
      notes: isNotes(entry.path),
    })),
  );
}

/**
 * Changes in the working folder that no commit holds, untracked files
 * included -- which plain `git diff` would not show at all (D31).
 */
export async function uncommittedChanges(worktree: string): Promise<ChangedFile[]> {
  const entries = await status(worktree);
  if (entries.length === 0) return [];
  const numbers = parseNumstat(await git([...DIFF, '--numstat', '-z', 'HEAD', '--'], worktree));

  const files = await Promise.all(
    entries.map(async (entry): Promise<ChangedFile> => {
      const counts = entry.untracked
        ? await countLines(join(worktree, entry.path))
        : (numbers.get(entry.path) ?? { added: 0, removed: 0, binary: false });
      return {
        path: entry.path,
        ...(entry.oldPath === undefined ? {} : { oldPath: entry.oldPath }),
        status: entry.untracked ? 'added' : statusFromPorcelain(entry.code),
        ...counts,
        notes: isNotes(entry.path),
        ...(entry.untracked ? { untracked: true } : {}),
      };
    }),
  );
  return sortByPath(files);
}

/** One committed file's patch. A rename names both paths, or git sees a delete and an add. */
export async function committedFilePatch(
  worktree: string,
  base: string,
  head: string,
  file: ChangedFile,
): Promise<{ patch: string; truncated: boolean }> {
  return capped(await git([...DIFF, base, head, '--', ...pathsOf(file)], worktree));
}

/** One uncommitted file's patch, against the last commit -- or against nothing, when untracked. */
export async function uncommittedFilePatch(
  worktree: string,
  file: ChangedFile,
): Promise<{ patch: string; truncated: boolean }> {
  if (file.untracked === true) {
    return capped(
      await gitDiffNoIndex(
        [
          '-c',
          'core.quotepath=false',
          'diff',
          '--no-ext-diff',
          '--no-index',
          '--',
          '/dev/null',
          file.path,
        ],
        worktree,
      ),
    );
  }
  return capped(await git([...DIFF, 'HEAD', '--', ...pathsOf(file)], worktree));
}

export function totalsOf(files: readonly ChangedFile[]): {
  files: number;
  added: number;
  removed: number;
} {
  return {
    files: files.length,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
  };
}

/**
 * `--name-status -z`: a status token, then one path -- or two for a rename or
 * a copy, old first.
 */
export function parseNameStatus(
  raw: string,
): Array<Pick<ChangedFile, 'path' | 'oldPath' | 'status'>> {
  const parts = raw.split('\0');
  const out: Array<Pick<ChangedFile, 'path' | 'oldPath' | 'status'>> = [];
  for (let i = 0; i < parts.length; i += 1) {
    const code = parts[i];
    if (code === undefined || code === '') continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[i + 1] ?? '';
      const path = parts[i + 2] ?? '';
      i += 2;
      out.push(letter === 'R' ? { path, oldPath, status: 'renamed' } : { path, status: 'added' });
      continue;
    }
    const path = parts[i + 1] ?? '';
    i += 1;
    out.push({
      path,
      status: letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified',
    });
  }
  return out;
}

/**
 * `--numstat -z`, keyed by the path the file ends up at. A binary file counts
 * '-' for both sides; a rename leaves the path field empty and follows the
 * record with the old and new paths.
 */
export function parseNumstat(
  raw: string,
): Map<string, { added: number; removed: number; binary: boolean }> {
  const parts = raw.split('\0');
  const out = new Map<string, { added: number; removed: number; binary: boolean }>();
  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i];
    if (record === undefined || record === '') continue;
    const [added = '', removed = '', ...rest] = record.split('\t');
    let path = rest.join('\t');
    if (path === '') {
      path = parts[i + 2] ?? '';
      i += 2;
    }
    const binary = added === '-' && removed === '-';
    out.set(path, {
      added: binary ? 0 : Number(added) || 0,
      removed: binary ? 0 : Number(removed) || 0,
      binary,
    });
  }
  return out;
}

function statusFromPorcelain(code: string): ChangeStatus {
  if (code.includes('D')) return 'deleted';
  if (code.startsWith('R')) return 'renamed';
  if (code.includes('A')) return 'added';
  return 'modified';
}

function isNotes(path: string): boolean {
  return path === NOTES_FILE || path.endsWith(`/${NOTES_FILE}`);
}

function pathsOf(file: ChangedFile): string[] {
  return file.oldPath === undefined ? [file.path] : [file.oldPath, file.path];
}

function sortByPath(files: ChangedFile[]): ChangedFile[] {
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function capped(patch: string): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch) <= MAX_PATCH_BYTES) return { patch, truncated: false };
  const cut = patch.slice(0, MAX_PATCH_BYTES);
  return { patch: cut.slice(0, Math.max(0, cut.lastIndexOf('\n') + 1)), truncated: true };
}

/** Lines in a new file, which git has no numstat for until it is tracked. */
async function countLines(
  path: string,
): Promise<{ added: number; removed: number; binary: boolean }> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_COUNTED_BYTES) {
      return { added: 0, removed: 0, binary: false };
    }
    const content = await readFile(path);
    // The same test git uses: a NUL in the first 8000 bytes means binary.
    if (content.subarray(0, 8000).includes(0)) return { added: 0, removed: 0, binary: true };
    let lines = 0;
    for (const byte of content) if (byte === 10) lines += 1;
    if (content.length > 0 && content[content.length - 1] !== 10) lines += 1;
    return { added: lines, removed: 0, binary: false };
  } catch {
    return { added: 0, removed: 0, binary: false };
  }
}
