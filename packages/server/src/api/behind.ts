import type { NodeRow, Store } from '../db/store.js';
import { gitLine } from '../git/exec.js';

/**
 * Where an experiment's code came from: the nearest ancestor that has
 * committed. Usually the parent; the grandparent when the parent has no
 * commits of its own, and so on up.
 */
export function codeSource(store: Store, row: NodeRow): NodeRow | undefined {
  let cursor = row.parent_id === null ? undefined : store.getNode(row.parent_id);
  while (cursor?.head_commit === null)
    cursor = cursor.parent_id === null ? undefined : store.getNode(cursor.parent_id);
  return cursor;
}

/**
 * How far an experiment is behind: the commits its code source has made since
 * the experiment started. Null when it is not behind. The experiment never
 * moves to them -- it keeps the code it started from.
 */
export async function behindBy(
  store: Store,
  row: NodeRow,
  repoPath: string,
): Promise<{ commits: number; parentId: string; parentName: string } | null> {
  const source = codeSource(store, row);
  if (row.base_commit === null || source?.head_commit == null) return null;
  if (source.head_commit === row.base_commit) return null;
  const commits = Number(
    await gitLine(['rev-list', '--count', `${row.base_commit}..${source.head_commit}`], repoPath),
  );
  return commits > 0 ? { commits, parentId: source.id, parentName: source.display_name } : null;
}
