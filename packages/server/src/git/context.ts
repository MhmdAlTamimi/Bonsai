import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONTEXT_FILE } from './commit.js';

/** D22: CONTEXT.md is a human-readable record shown in the panel, not memory. */
export async function readContextFile(worktreePath: string): Promise<string | null> {
  try {
    return await readFile(join(worktreePath, CONTEXT_FILE), 'utf8');
  } catch {
    return null;
  }
}
