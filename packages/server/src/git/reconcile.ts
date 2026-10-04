import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GitRecoveryView, SynchronizeAction } from '@bonsai/shared';
import type { NodeRow, Store } from '../db/store.js';
import { isUsersOwnCheckout } from '../db/rows.js';
import { OperationConflict } from '../domain/errors.js';
import { samePath } from '../paths.js';
import { diffStat } from './commit.js';
import { copyWorkingFiles, exportExperiment, protectExportTips } from './export.js';
import { git, gitLine, status } from './exec.js';
import { expectedGitState, readGitState } from './ownership.js';
import { branchOf, deleteRef, nodeRef, readRef, tipOf } from './refs.js';
import { saveRef } from './saveRecovery.js';
import { commitExists } from './repo.js';
import { indexTrees, workingTreeSnapshot } from './snapshot.js';
import { addDetachedWorktree, removeWorktree } from './worktree.js';

/** Readable even when a folder disappeared; never changes refs or work. */
export async function gitRecovery(store: Store, node: NodeRow): Promise<GitRecoveryView | null> {
  const project = store.getProject(node.project_id)!;
  if (isUsersOwnCheckout(project, node)) return null;
  const recorded = tipOf(node);
  const folderExists = existsSync(node.worktree_path);
  let problem: GitRecoveryView['problem'] = 'drift';
  let message =
    'Git and Bonsai have different saved code. Choose which version this experiment should use. Current files, ignored files and all known commits will be preserved in an independent recovery folder first.';
  let head: string | null = null;
  let saved: string | null = null;
  let branch: string | null = null;
  let changed: string[] = [];
  let safeRepo = false;
  let recordedExists = false;
  let unmerged = false;
  try {
    const expected = await expectedGitState(project.repo_path, node);
    saved = await readRef(project.repo_path, nodeRef(project.id, node.id));
    recordedExists = recorded !== null && (await commitExists(project.repo_path, recorded));
    safeRepo = true;
    if (node.worktree_allocated !== 0 && !folderExists) {
      problem = 'missing_folder';
      message =
        'The experiment folder is missing. Its Git history is still available. Restore its recorded folder, or import its latest saved Git commit. Uncommitted files need your own backup.';
    } else if (folderExists && node.worktree_allocated !== 0) {
      const actual = await readGitState(node.worktree_path);
      head = actual.head;
      branch = actual.branch;
      if (!samePath(actual.commonDir, expected.commonDir)) {
        safeRepo = false;
        problem = 'foreign_repository';
        message =
          'This folder now belongs to a different Git repository. Preserve it with your Git tools, then locate the original repository or restore your backup. Bonsai will not alter this folder.';
      } else {
        const entries = await status(node.worktree_path);
        changed = entries.map((entry) => entry.path);
        unmerged = entries.some(
          (entry) => entry.code.includes('U') || entry.code === 'AA' || entry.code === 'DD',
        );
        if (unmerged)
          message +=
            ' Git has unresolved merge conflicts. Resolve them before importing folder state, or preserve and restore the recorded code.';
        if (
          head === recorded &&
          branch === branchOf(node) &&
          (saved === recorded || saved === null)
        )
          return null;
      }
    } else if (saved === recorded || saved === null) return null;
    if (!recordedExists) {
      problem = 'missing_commit';
      message =
        'The recorded Git commit is missing. You can import available folder or saved code; restoring the original requires a backup.';
    }
  } catch (error) {
    safeRepo = false;
    problem = existsSync(project.repo_path) ? 'unreadable_repository' : 'missing_repository';
    message = `Bonsai cannot read this repository at ${project.repo_path}. Locate the moved repository or restore your backup. ${error instanceof Error ? error.message : String(error)}`;
  }
  const version = createHash('sha256')
    .update(JSON.stringify({ recorded, head, saved, branch, changed, problem, folderExists }))
    .digest('hex');
  return {
    version,
    problem,
    message,
    recordedCommit: recorded,
    folderCommit: head,
    savedCommit: saved,
    changedFiles: changed,
    canImportFolder: safeRepo && head !== null && !unmerged,
    canImportSaved: safeRepo && saved !== null && saved !== recorded,
    canRestore: safeRepo && recordedExists,
  };
}

/** User-selected reconciliation. Preserve first, re-check, then update only the owned checkout/ref. */
export async function synchronizeExperiment(
  store: Store,
  node: NodeRow,
  action: SynchronizeAction,
  version: string,
): Promise<string> {
  const project = store.getProject(node.project_id)!;
  const observed = await gitRecovery(store, node);
  if (observed?.version !== version)
    throw new OperationConflict(
      'Git changed while this recovery was open. Refresh and review the current versions.',
    );
  const allowed =
    action === 'import-folder'
      ? observed.canImportFolder
      : action === 'import-saved'
        ? observed.canImportSaved
        : action === 'restore' && observed.canRestore;
  if (!allowed)
    throw new OperationConflict('This recovery choice is unavailable for the current Git state.');
  const folderHead = observed.folderCommit;
  const pendingSaves = store.saves.pending().filter((save) => save.nodeId === node.id);
  const tree = folderHead === null ? null : await workingTreeSnapshot(node.worktree_path);
  const snapshot =
    tree === null
      ? null
      : await gitLine(
          [
            'commit-tree',
            tree,
            '-p',
            folderHead!,
            '-m',
            'Preserve experiment before explicit Bonsai synchronization',
          ],
          project.repo_path,
        );
  const stagedTrees = folderHead === null ? {} : await indexTrees(node.worktree_path);
  const stagedTips: Record<string, string> = {};
  for (const [name, stagedTree] of Object.entries(stagedTrees))
    stagedTips[name] = await gitLine(
      ['commit-tree', stagedTree, '-p', folderHead!, '-m', `Preserve ${name} experiment content`],
      project.repo_path,
    );
  const selected =
    action === 'import-folder'
      ? snapshot!
      : action === 'import-saved'
        ? observed.savedCommit!
        : observed.recordedCommit!;
  const preserved = await exportExperiment(
    project.repo_path,
    snapshot ?? observed.savedCommit ?? selected,
    join(store.projectScratchDir(project.id), 'recovery'),
    node.display_name,
  );
  await protectExportTips(preserved, project.repo_path, {
    ...Object.fromEntries(pendingSaves.map((save) => [`save-${save.runId}`, save.after])),
    recorded: (await commitExists(project.repo_path, observed.recordedCommit ?? ''))
      ? observed.recordedCommit
      : null,
    saved: observed.savedCommit,
    folder: folderHead,
    ...stagedTips,
  });
  if (folderHead !== null) await copyWorkingFiles(node.worktree_path, preserved);
  const fresh = await gitRecovery(store, store.getNode(node.id)!);
  if (
    fresh?.version !== version ||
    (folderHead !== null &&
      ((await workingTreeSnapshot(node.worktree_path)) !== tree ||
        JSON.stringify(await indexTrees(node.worktree_path)) !== JSON.stringify(stagedTrees)))
  )
    throw new OperationConflict(
      `Git or files changed during preservation. Nothing was reset. A recovery copy is at ${preserved}. Refresh and try again.`,
    );

  // A user-created branch is never reset. The owned checkout becomes detached,
  // and every former branch tip is kept in the recovery repository.
  if (folderHead === null) {
    await removeWorktree(project.repo_path, node.worktree_path);
    await addDetachedWorktree(project.repo_path, node.worktree_path, selected);
  } else {
    await git(['checkout', '--detach', '--force', selected], node.worktree_path);
    await git(['clean', '-fd'], node.worktree_path);
  }
  await git(
    ['update-ref', nodeRef(project.id, node.id), selected, observed.savedCommit ?? ''],
    project.repo_path,
  );
  const runId = randomUUID();
  store.enqueueRun(runId, node.id, {
    prompt:
      action === 'restore'
        ? 'Restore the recorded Bonsai code'
        : 'Import preserved Git code into Bonsai',
    command: true,
    referenceIds: [],
    experimentIds: [],
  });
  const base = node.base_commit ?? observed.recordedCommit ?? selected;
  store.completeRun(
    runId,
    node.id,
    { status: 'done', reason: 'finished', error: null },
    {
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      commitSha: selected,
      stat: await diffStat(project.repo_path, base, selected),
    },
    {
      status: 'ready',
      commit: { branch: nodeRef(project.id, node.id), head: selected },
      abandonSaves: pendingSaves.map((save) => save.runId),
      restored: true,
    },
  );
  for (const save of pendingSaves)
    await deleteRef(project.repo_path, saveRef(project.id, save.runId), save.after);
  store.appendMessage({
    nodeId: node.id,
    runId,
    role: 'system',
    kind: 'text',
    content: `Git and Bonsai synchronized. The previous files, including ignored files, and saved commits are preserved at ${preserved}.`,
  });
  return preserved;
}
