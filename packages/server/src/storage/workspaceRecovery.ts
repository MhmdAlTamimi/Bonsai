import { existsSync } from 'node:fs';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from '../db/store.js';
import { OperationConflict } from '../domain/errors.js';
import { git, gitLine, status } from '../git/exec.js';
import { copyWorkingFiles, exportExperiment, protectExportTips } from '../git/export.js';
import { assertGitState, expectedGitState, readGitState, type GitState } from '../git/ownership.js';
import { nodeRef, readRef, tipOf } from '../git/refs.js';
import { indexTrees, workingTreeSnapshot } from '../git/snapshot.js';
import { addDetachedWorktree, assertWorktreeUnlocked, removeWorktree } from '../git/worktree.js';
import {
  checkedPath,
  localFilesDir,
  stopNodeLeftovers,
  withProjectWorkspace,
  type WorkspaceSwitch,
  retryWorkspaceSwitch,
} from '../jobs/projectWorkspace.js';
import { samePath } from '../paths.js';
import { fingerprint } from './fingerprint.js';

interface RecoveryIntent {
  nodeId: string;
  tip: string;
  refBefore: string | null;
  generation: number;
  before: GitState | null;
  digest: string | null;
  indexes: Record<string, string>;
  preserved: string;
  raw: string;
  stage: 'preserved' | 'checkout' | 'restore';
}

/** Explicit user fallback. Exact copies are verified before replacing an owned checkout. */
export async function restoreWorkspace(
  store: Store,
  projectId: string,
  recoveryRoot: string,
): Promise<string> {
  return withProjectWorkspace(store, projectId, async () => {
    const workspace = store.workspaces.get(projectId);
    const key = `workspace_recovery:${projectId}`;
    const saved = store.metadata(key);
    if (!workspace?.switch_json) {
      if (workspace && saved) {
        const completed = JSON.parse(saved) as RecoveryIntent;
        if (
          workspace.active_node_id === completed.nodeId &&
          workspace.generation === completed.generation + 1
        ) {
          await assertGitState(workspace.path, {
            ...(await expectedGitState(
              store.getProject(projectId)!.repo_path,
              store.getNode(completed.nodeId)!,
            )),
            head: completed.tip,
            branch: null,
          });
          store.setMetadata(key, null);
          store.setMetadata(`workspace_recovery_copy:${projectId}`, completed.preserved);
          return completed.preserved;
        }
      }
      throw new OperationConflict('No matching interrupted workspace preparation can be restored.');
    }
    const project = store.getProject(projectId)!;
    const pending = JSON.parse(workspace.switch_json) as WorkspaceSwitch;
    if (pending.sourceNodeId) await stopNodeLeftovers(store, pending.sourceNodeId);
    await stopNodeLeftovers(store, pending.nodeId);
    let intent: RecoveryIntent;
    if (saved) intent = JSON.parse(saved) as RecoveryIntent;
    else {
      if (store.saves.pending().some((save) => save.projectId === projectId))
        throw new OperationConflict(
          'Resolve the unfinished run save before restoring this workspace.',
        );
      const node = store.getNode(pending.sourceNodeId ?? pending.nodeId)!;
      const tip = tipOf(node)!;
      const expected = await expectedGitState(project.repo_path, node);
      const before = existsSync(workspace.path) ? await readGitState(workspace.path) : null;
      if (before && !samePath(before.commonDir, expected.commonDir))
        throw new OperationConflict(
          'The workspace belongs to a foreign repository. Its files were preserved; restore the original repository first.',
        );
      if (before) await assertWorktreeUnlocked(workspace.path);
      const digest = before ? await fingerprint(workspace.path, 'raw') : null;
      const tree = before ? await workingTreeSnapshot(workspace.path) : null;
      const snapshot =
        tree && before
          ? await gitLine(
              [
                'commit-tree',
                tree,
                '-p',
                before.head,
                '-m',
                'Preserve interrupted workspace preparation',
              ],
              project.repo_path,
            )
          : tip;
      const staged = before ? await indexTrees(workspace.path) : {};
      const stagedTips: Record<string, string> = {};
      for (const [name, index] of Object.entries(staged))
        stagedTips[name] = await gitLine(
          ['commit-tree', index, '-p', before!.head, '-m', `Preserve ${name}`],
          project.repo_path,
        );
      const preserved = await exportExperiment(
        project.repo_path,
        snapshot,
        recoveryRoot,
        'workspace-recovery',
      );
      await protectExportTips(preserved, project.repo_path, {
        recorded: tip,
        folder: before?.head ?? null,
        ...Object.fromEntries(store.listNodes(projectId).map((node) => [node.id, tipOf(node)])),
        ...stagedTips,
      });
      const raw = `${preserved}-working-files`;
      await mkdir(raw, { mode: 0o700 });
      if (before) {
        await copyWorkingFiles(workspace.path, raw, { raw: true });
        if (
          (await fingerprint(raw, 'raw')) !== digest ||
          (await fingerprint(workspace.path, 'raw')) !== digest ||
          JSON.stringify(await readGitState(workspace.path)) !== JSON.stringify(before) ||
          JSON.stringify(await indexTrees(workspace.path)) !== JSON.stringify(staged)
        )
          throw new OperationConflict(
            `Files changed during preservation. Nothing was reset. Copies are at ${preserved} and ${raw}.`,
          );
      }
      // Copy the exact local stores as well, so deleting the project cannot invalidate recovery.
      for (const id of new Set([pending.sourceNodeId, pending.nodeId])) {
        if (!id) continue;
        const source = localFilesDir(store, projectId, id);
        if (existsSync(source)) {
          const copy = `${preserved}-local-${id}`;
          const digest = await fingerprint(source, 'local');
          await cp(source, copy, { recursive: true, dereference: false, preserveTimestamps: true });
          if (
            (await fingerprint(copy, 'local')) !== digest ||
            (await fingerprint(source, 'local')) !== digest
          )
            throw new OperationConflict(
              'Local files changed during preservation. Nothing was reset.',
            );
        }
      }
      // Recorded provenance tells us which preserved paths were still in the interrupted folder.
      const ownerId = pending.stage === 'restore' ? pending.nodeId : pending.sourceNodeId;
      const paths = pending.stage === 'restore' ? pending.restore : pending.preserved;
      if (ownerId) {
        for (const path of paths) {
          const to = await checkedPath(
            join(localFilesDir(store, projectId, ownerId), 'files'),
            path,
          );
          const from = await checkedPath(raw, path);
          if (!existsSync(to) && existsSync(from)) {
            await mkdir(join(to, '..'), { recursive: true, mode: 0o700 });
            await cp(from, to, { recursive: true, dereference: false, preserveTimestamps: true });
          }
        }
      }
      intent = {
        nodeId: node.id,
        tip,
        refBefore: await readRef(project.repo_path, nodeRef(projectId, node.id)),
        generation: workspace.generation,
        before,
        digest,
        indexes: staged,
        preserved,
        raw,
        stage: 'preserved',
      };
      store.setMetadata(key, JSON.stringify(intent));
    }
    if (
      workspace.generation !== intent.generation ||
      tipOf(store.getNode(intent.nodeId)!) !== intent.tip
    )
      throw new OperationConflict(
        'The experiment changed after recovery began. Recovery copies are preserved.',
      );
    if (intent.stage === 'preserved') {
      if (existsSync(workspace.path)) {
        if (
          !intent.before ||
          JSON.stringify(await readGitState(workspace.path)) !== JSON.stringify(intent.before) ||
          (await fingerprint(workspace.path, 'raw')) !== intent.digest ||
          JSON.stringify(await indexTrees(workspace.path)) !== JSON.stringify(intent.indexes)
        )
          throw new OperationConflict(
            'The workspace changed after preservation. Inspect the recovery copies before retrying.',
          );
        await assertWorktreeUnlocked(workspace.path);
      }
      await removeWorktree(project.repo_path, workspace.path);
      intent.stage = 'checkout';
      store.setMetadata(key, JSON.stringify(intent));
    }
    if (intent.stage === 'checkout') {
      if (!existsSync(workspace.path))
        await addDetachedWorktree(project.repo_path, workspace.path, intent.tip);
      const actual = await readGitState(workspace.path);
      if (
        actual.head !== intent.tip ||
        actual.branch !== null ||
        !samePath(
          actual.commonDir,
          (await expectedGitState(project.repo_path, store.getNode(intent.nodeId)!)).commonDir,
        ) ||
        (await status(workspace.path)).length
      )
        throw new OperationConflict('Unexpected code in the restored workspace. Files preserved.');
      const ref = nodeRef(projectId, intent.nodeId);
      const current = await readRef(project.repo_path, ref);
      if (current !== intent.tip) {
        if (current !== intent.refBefore)
          throw new OperationConflict('The experiment ref changed during recovery.');
        await git(['update-ref', ref, intent.tip, current ?? ''], project.repo_path);
      }
      const manifestPath = join(localFilesDir(store, projectId, intent.nodeId), 'manifest.json');
      const restore = JSON.parse(
        await readFile(manifestPath, 'utf8').catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '[]';
          throw error;
        }),
      ) as string[];
      const restored: WorkspaceSwitch = {
        ...pending,
        nodeId: intent.nodeId,
        target: intent.tip,
        before: null,
        preserved: [],
        disposable: [],
        restore,
        stage: 'restore',
        release: false,
      };
      store.workspaces.journal(projectId, restored);
      intent.stage = 'restore';
      store.setMetadata(key, JSON.stringify(intent));
    }
    await retryWorkspaceSwitch(store, projectId);
    store.setMetadata(key, null);
    store.setMetadata(`workspace_recovery_copy:${projectId}`, intent.preserved);
    return intent.preserved;
  });
}
