import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './exec.js';

/** Include eligible untracked files without changing the checkout, refs or real index. */
export async function workingTreeSnapshot(path: string): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), 'bonsai-index-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    await git(['read-tree', 'HEAD'], path, env);
    await git(['add', '-A', '--', '.'], path, env);
    return (await git(['write-tree'], path, env)).trim();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
