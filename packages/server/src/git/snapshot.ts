import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitLine } from './exec.js';

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
