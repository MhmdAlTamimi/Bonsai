import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReviewFile, ReviewStatus } from '@bonsai/shared';

import { git, gitDiffNoIndex, status } from './exec.js';

/**
 * What an experiment changed, as review reads it: one list of files with a
 * status letter and its counts, and one file's patch at a time.
 *
 * Never the whole patch at once. A run that writes a hundred and eighty files
 * has a patch of several megabytes, and review opens with a list — the file
 * you pick is the only one anyone reads first.
 *
 * Committed work and uncommitted work are ONE list, because from the outside
 * they are one answer to "what did this experiment do". Which is which is in
 * the letter: A added, M modified, D deleted, R renamed, U not tracked yet.
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

export async function reviewFiles(
  worktree: string,
  range: { base: string; head: string } | null,
): Promise<ReviewFile[]> {
  const committed = range === null ? [] : await committedFiles(worktree, range);
  const uncommitted = await uncommittedFiles(worktree);

  // A file changed in a commit AND since is shown once, in the state it is in
  // now: the working tree is what the next run will see.
  const byPath = new Map(committed.map((file) => [file.path, file]));
  for (const file of uncommitted) byPath.set(file.path, file);
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function committedFiles(
  worktree: string,
  range: { base: string; head: string },
): Promise<ReviewFile[]> {
  const [names, counts] = await Promise.all([
    git([...DIFF, '--name-status', '-z', range.base, range.head, '--'], worktree),
    git([...DIFF, '--numstat', '-z', range.base, range.head, '--'], worktree),
  ]);
  const numbers = parseNumstat(counts);
  return parseNameStatus(names).map((entry) => ({
    ...entry,
    ...(numbers.get(entry.path) ?? { additions: 0, deletions: 0, binary: false }),
  }));
}

/** What is in the folder and not committed, untracked files included (D31). */
async function uncommittedFiles(worktree: string): Promise<ReviewFile[]> {
  const entries = await status(worktree);
  if (entries.length === 0) return [];
  const numbers = parseNumstat(await git([...DIFF, '--numstat', '-z', 'HEAD', '--'], worktree));

  return Promise.all(
    entries.map(async (entry): Promise<ReviewFile> => {
      const counts = entry.untracked
        ? await countLines(join(worktree, entry.path))
        : (numbers.get(entry.path) ?? { additions: 0, deletions: 0, binary: false });
      return {
        path: entry.path,
        ...(entry.oldPath === undefined ? {} : { oldPath: entry.oldPath }),
        status: entry.untracked ? 'U' : letterFor(entry.code),
        uncommitted: true,
        ...counts,
      };
    }),
  );
}

/** One file's patch: from the commits for committed work, from the folder otherwise. */
export async function reviewFilePatch(
  worktree: string,
  range: { base: string; head: string } | null,
  file: ReviewFile,
): Promise<{ patch: string; truncated: boolean }> {
  const paths = file.oldPath === undefined ? [file.path] : [file.oldPath, file.path];
  if (file.status === 'U') {
    // Untracked: there is no "before", so the file is diffed against nothing.
    return cap(
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
  if (file.uncommitted === true) return cap(await git([...DIFF, 'HEAD', '--', ...paths], worktree));
  if (range === null) return { patch: '', truncated: false };
  return cap(await git([...DIFF, range.base, range.head, '--', ...paths], worktree));
}

export function totalsOf(files: readonly ReviewFile[]): {
  files: number;
  added: number;
  removed: number;
} {
  return {
    files: files.length,
    added: files.reduce((n, f) => n + f.additions, 0),
    removed: files.reduce((n, f) => n + f.deletions, 0),
  };
}

/** `--name-status -z`: a status token, then a path — or two for a rename. */
export function parseNameStatus(
  raw: string,
): Array<Omit<ReviewFile, 'additions' | 'deletions' | 'binary'>> {
  const parts = raw.split('\0');
  const out: Array<Omit<ReviewFile, 'additions' | 'deletions' | 'binary'>> = [];
  for (let i = 0; i < parts.length; i += 1) {
    const code = parts[i];
    if (code === undefined || code === '') continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[i + 1] ?? '';
      const path = parts[i + 2] ?? '';
      i += 2;
      out.push(letter === 'R' ? { path, oldPath, status: 'R' } : { path, status: 'A' });
      continue;
    }
    const path = parts[i + 1] ?? '';
    i += 1;
    out.push({ path, status: letterFor(code) });
  }
  return out;
}

/**
 * `--numstat -z`, keyed by where the file ends up. A binary file counts '-'
 * for both sides; a rename leaves the path empty and follows with old and new.
 */
export function parseNumstat(
  raw: string,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const parts = raw.split('\0');
  const out = new Map<string, { additions: number; deletions: number; binary: boolean }>();
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
      additions: binary ? 0 : Number(added) || 0,
      deletions: binary ? 0 : Number(removed) || 0,
      binary,
    });
  }
  return out;
}

function letterFor(code: string): ReviewStatus {
  if (code.includes('D')) return 'D';
  if (code.startsWith('R')) return 'R';
  if (code.includes('A')) return 'A';
  return 'M';
}

function cap(patch: string): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch) <= MAX_PATCH_BYTES) return { patch, truncated: false };
  const cut = patch.slice(0, MAX_PATCH_BYTES);
  return { patch: cut.slice(0, Math.max(0, cut.lastIndexOf('\n') + 1)), truncated: true };
}

/** Lines in a new file, which git has no numstat for until it is tracked. */
async function countLines(
  path: string,
): Promise<{ additions: number; deletions: number; binary: boolean }> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_COUNTED_BYTES) {
      return { additions: 0, deletions: 0, binary: false };
    }
    const content = await readFile(path);
    // The same test git uses: a NUL in the first 8000 bytes means binary.
    if (content.subarray(0, 8000).includes(0)) {
      return { additions: 0, deletions: 0, binary: true };
    }
    let lines = 0;
    for (const byte of content) if (byte === 10) lines += 1;
    if (content.length > 0 && content[content.length - 1] !== 10) lines += 1;
    return { additions: lines, deletions: 0, binary: false };
  } catch {
    return { additions: 0, deletions: 0, binary: false };
  }
}
