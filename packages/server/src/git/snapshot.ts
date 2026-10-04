import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitInput, gitLine } from './exec.js';

/** Include eligible untracked files without changing the checkout, refs or real index. */
export async function workingTreeSnapshot(path: string): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), 'bonsai-index-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    // Reuse Git's file-stat cache without ever writing the user's index.
    // An empty index would force add -A to hash every tracked file again.
    const index = await gitLine(
      ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
      path,
    );
    try {
      await copyFile(index, env.GIT_INDEX_FILE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await git(['read-tree', 'HEAD'], path, env);
    }
    await git(['add', '-A', '--', '.'], path, env);
    return (await git(['write-tree'], path, env)).trim();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Preserve the real index, including all three versions of unresolved merge conflicts. */
export async function indexTrees(path: string): Promise<Record<string, string>> {
  const entries = (await git(['ls-files', '--stage', '-z'], path))
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]*)$/.exec(line);
      if (match === null) throw new Error('Git returned an unreadable index entry.');
      return { mode: match[1]!, object: match[2]!, stage: Number(match[3]), path: match[4]! };
    });
  const stages = [...new Set(entries.map((entry) => entry.stage).filter((stage) => stage !== 0))];
  if (stages.length === 0) return { staged: await gitLine(['write-tree'], path) };
  const scratch = await mkdtemp(join(tmpdir(), 'bonsai-index-stages-'));
  try {
    const trees: Record<string, string> = {};
    for (const stage of stages) {
      const env = { GIT_INDEX_FILE: join(scratch, `index-${stage}`) };
      await git(['read-tree', '--empty'], path, env);
      const input = entries
        .filter((entry) => entry.stage === 0 || entry.stage === stage)
        .map((entry) => `${entry.mode} ${entry.object}\t${entry.path}\0`)
        .join('');
      await gitInput(['update-index', '-z', '--index-info'], path, input, env);
      trees[`stage-${stage}`] = (await git(['write-tree'], path, env)).trim();
    }
    return trees;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
