import type { Store } from '../db/store.js';
import type { Logger } from '../log.js';
import { samePath } from '../paths.js';
import { OperationConflict } from '../domain/errors.js';
import { advanceCommit } from './commit.js';
import { readGitState } from './ownership.js';
import { deleteRef, nodeRef, pinRef, readRef, tipOf } from './refs.js';

export const saveRef = (projectId: string, runId: string): string =>
  `refs/bonsai/${projectId}/saves/${runId}`;

/** Finish only an exact, durable Bonsai save. Unknown Git state stays untouched. */
export async function recoverRunSaves(store: Store, log: Logger): Promise<number> {
  let completed = 0;
  for (const save of store.saves.pending()) {
    try {
      const node = store.getNode(save.nodeId);
      const project = store.getProject(save.projectId);
      const workspace = store.workspaces.get(save.projectId);
      if (
        workspace &&
        (workspace.active_node_id !== save.nodeId ||
          workspace.switch_json ||
          (save.workspaceGeneration !== undefined &&
            workspace.generation !== save.workspaceGeneration))
      )
        throw new OperationConflict(
          'The workspace no longer belongs to this recorded save. Work preserved.',
        );
      if (
        !node ||
        !project ||
        !samePath(project.repo_path, save.repoPath) ||
        !samePath(node.worktree_path, save.worktreePath) ||
        ![save.before.head, save.after].includes(tipOf(node) ?? '')
      )
        throw new OperationConflict(
          'The recorded experiment changed after this save was prepared.',
        );
      const actual = await readGitState(save.worktreePath);
      const ref = nodeRef(save.projectId, save.nodeId);
      const saved = await readRef(save.repoPath, ref);
      if (
        !samePath(actual.commonDir, save.before.commonDir) ||
        actual.branch !== save.before.branch ||
        ![save.before.head, save.after].includes(actual.head) ||
        saved === null ||
        ![save.before.head, save.after].includes(saved)
      )
        throw new OperationConflict(
          'Git contains changes outside this recorded Bonsai save. Work is preserved.',
        );
      await pinRef(save.repoPath, saveRef(save.projectId, save.runId), save.after);
      if (actual.head !== save.after || saved !== save.after)
        await advanceCommit(save.worktreePath, actual.branch, ref, actual.head, saved, save.after);
      store.completeRun(
        save.runId,
        save.nodeId,
        { status: 'done', reason: 'finished', error: null },
        save.totals,
        save.node,
      );
      await deleteRef(save.repoPath, saveRef(save.projectId, save.runId), save.after);
      completed += 1;
      log.info('run.save_recovered', { runId: save.runId, nodeId: save.nodeId });
    } catch (error) {
      log.warn('run.save_recovery_blocked', {
        runId: save.runId,
        nodeId: save.nodeId,
        error: String(error),
      });
    }
  }
  return completed;
}
