import { workingTreeSnapshot } from './snapshot.js';
import type { ReviewFile, ReviewStatus } from '@bonsai/shared';

import { git, gitPatch, status } from './exec.js';

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

export async function reviewFiles(
  worktree: string,
  range: { base: string; head: string } | null,
): Promise<ReviewFile[]> {
  const dirty = await status(worktree);
  const head = dirty.length === 0 ? (range?.head ?? 'HEAD') : await workingTreeSnapshot(worktree);
  const files = await committedFiles(worktree, { base: range?.base ?? 'HEAD', head });
  return files
    .map((file) => {
      const entry = dirty.find(
        (item) =>
          item.path === file.path || item.path === file.oldPath || item.oldPath === file.path,
      );
      return {
        ...file,
        ...(entry === undefined
          ? {}
          : {
              uncommitted: true,
              ...(entry.untracked && file.status === 'A' ? { status: 'U' as const } : {}),
            }),
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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

/** Review always compares the inherited base with the complete current snapshot. */
export async function reviewFilePatch(
  worktree: string,
  range: { base: string; head: string } | null,
  file: ReviewFile,
): Promise<{ patch: string; truncated: boolean }> {
  const paths = file.oldPath === undefined ? [file.path] : [file.oldPath, file.path];
  const dirty = await status(worktree);
  const head = dirty.length === 0 ? (range?.head ?? 'HEAD') : await workingTreeSnapshot(worktree);
  return gitPatch(
    [...DIFF, range?.base ?? 'HEAD', head, '--', ...paths],
    worktree,
    MAX_PATCH_BYTES,
  );
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

/** Read Git objects, never follow a worktree symlink into unrelated host files. */
export async function reviewFileContent(
  worktree: string,
  range: { base: string; head: string } | null,
  file: ReviewFile,
): Promise<{
  content: string;
  truncated: boolean;
  contentRevision: 'current' | 'before-deletion';
}> {
  const dirty = await status(worktree);
  const head = dirty.length === 0 ? (range?.head ?? 'HEAD') : await workingTreeSnapshot(worktree);
  const deleted = file.status === 'D';
  const revision = deleted ? (range?.base ?? 'HEAD') : head;
  const result = await gitPatch(
    ['show', `${revision}:${deleted ? (file.oldPath ?? file.path) : file.path}`],
    worktree,
    MAX_PATCH_BYTES,
  );
  return {
    content: result.patch,
    truncated: result.truncated,
    contentRevision: deleted ? 'before-deletion' : 'current',
  };
}
