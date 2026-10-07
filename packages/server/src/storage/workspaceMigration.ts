import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeRow, Store } from '../db/store.js';
import { isUsersOwnCheckout } from '../db/rows.js';
import { OperationConflict } from '../domain/errors.js';
import { git, ignoredPaths, status } from '../git/exec.js';
import { assertGitState, expectedGitState, readGitState, type GitState } from '../git/ownership.js';
import { pinNode, tipOf } from '../git/refs.js';
import { addDetachedWorktree, assertWorktreeUnlocked, removeWorktree } from '../git/worktree.js';
import { samePath } from '../paths.js';
import {
  preserveLocalFiles,
  removeDisposableFiles,
  validateRebuildPaths,
  withProjectWorkspace,
  stopNodeLeftovers,
} from '../jobs/projectWorkspace.js';

interface MigrationFolder {
  node: NodeRow;
  before: GitState;
  preserved: string[];
  disposable: string[];
}
interface MigrationIntent {
  projectId: string;
  path: string;
  nodeId: string;
  folders: MigrationFolder[];
  rebuildPaths: string[];
}
export interface WorkspaceMigrationView {
  version: string;
  folders: number;
  preservedFiles: number;
  blocked: string[];
  pending: boolean;
}

async function inspect(
  store: Store,
  projectId: string,
): Promise<{ view: WorkspaceMigrationView; intent: MigrationIntent }> {
  const project = store.getProject(projectId);
  if (!project) throw new OperationConflict('No such project.');
  const nodes = store.listNodes(projectId);
  const root = nodes.find((node) => node.parent_id === null)!;
  const rebuildPaths = validateRebuildPaths(
    JSON.parse(store.metadata(`workspace_rebuild:${projectId}`) ?? '[]') as string[],
  );
  const blocked: string[] = [];
  if (store.saves.pending().some((save) => save.projectId === projectId))
    blocked.push('Recover the unfinished code save first.');
  if (store.deletions.pending().some((intent) => intent.project.id === projectId))
    blocked.push('Finish or cancel the pending deletion first.');
  const folders: MigrationFolder[] = [];
  for (const node of nodes) {
    try {
      await stopNodeLeftovers(store, node.id);
      await pinNode(project.repo_path, node);
      if (isUsersOwnCheckout(project, node)) continue;
      if (!node.worktree_allocated) {
        if (existsSync(node.worktree_path))
          throw new OperationConflict(
            'An unexpected folder occupies an unallocated location. Preserve/import it first.',
          );
        continue;
      }
      await assertGitState(node.worktree_path, await expectedGitState(project.repo_path, node));
      await assertWorktreeUnlocked(node.worktree_path);
      if ((await status(node.worktree_path)).length)
        throw new OperationConflict('Save/import or discard unfinished changes first.');
      const submodules = await git(
        ['submodule', 'foreach', '--quiet', '--recursive', 'git status --porcelain --ignored'],
        node.worktree_path,
      );
      if (submodules.trim())
        throw new OperationConflict(
          'A submodule has local files. Preserve those before converting.',
        );
      const ignored = (await ignoredPaths(node.worktree_path)).map((path) =>
        path.replace(/\/$/, ''),
      );
      const disposable = ignored.filter((path) =>
        rebuildPaths.some((root) => path === root || path.startsWith(`${root}/`)),
      );
      folders.push({
        node,
        before: await readGitState(node.worktree_path),
        disposable,
        preserved: ignored.filter((path) => !disposable.includes(path)),
      });
    } catch (error) {
      blocked.push(
        `${node.display_name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const reused =
    project.source_kind === 'created'
      ? folders.find((folder) => folder.node.id === root.id)
      : undefined;
  const path = reused?.node.worktree_path ?? join(store.projectScratchDir(projectId), 'workspace');
  if (!reused && existsSync(path))
    blocked.push('An unexpected folder occupies the new workspace location.');
  const intent: MigrationIntent = { projectId, path, nodeId: root.id, folders, rebuildPaths };
  const version = createHash('sha256').update(JSON.stringify({ intent, blocked })).digest('hex');
  return {
    intent,
    view: {
      version,
      folders: folders.length,
      preservedFiles: folders.reduce((n, f) => n + f.preserved.length, 0),
      blocked,
      pending: false,
    },
  };
}

export async function workspaceMigrationView(
  store: Store,
  projectId: string,
): Promise<WorkspaceMigrationView> {
  const pending = store.metadata(`workspace_migration:${projectId}`);
  if (pending) {
    const intent = JSON.parse(pending) as MigrationIntent;
    return {
      version: createHash('sha256').update(pending).digest('hex'),
      folders: intent.folders.length,
      preservedFiles: intent.folders.reduce((n, f) => n + f.preserved.length, 0),
      blocked: [],
      pending: true,
    };
  }
  if (store.workspaces.get(projectId))
    throw new OperationConflict('This project already uses a shared workspace.');
  return (await inspect(store, projectId)).view;
}

export async function migrateProjectWorkspace(
  store: Store,
  projectId: string,
  version: string,
): Promise<void> {
  await withProjectWorkspace(
    store,
    projectId,
    async () => {
      const key = `workspace_migration:${projectId}`;
      const pending = store.metadata(key);
      let intent: MigrationIntent;
      if (pending) {
        if (createHash('sha256').update(pending).digest('hex') !== version)
          throw new OperationConflict('Conversion changed. Refresh and retry.');
        intent = JSON.parse(pending) as MigrationIntent;
      } else {
        const result = await inspect(store, projectId);
        if (result.view.version !== version)
          throw new OperationConflict('Project files changed. Refresh the conversion preview.');
        if (result.view.blocked.length) throw new OperationConflict(result.view.blocked.join('\n'));
        intent = result.intent;
        store.setMetadata(key, JSON.stringify(intent));
      }
      await finishMigration(store, intent);
    },
    true,
  );
}

async function finishMigration(store: Store, intent: MigrationIntent): Promise<void> {
  const project = store.getProject(intent.projectId)!;
  for (const node of store.listNodes(project.id)) await pinNode(project.repo_path, node);
  if (
    store.saves.pending().some((save) => save.projectId === project.id) ||
    store.deletions.pending().some((deletion) => deletion.project.id === project.id)
  )
    throw new OperationConflict('Resolve pending saves/deletions before continuing conversion.');
  for (const folder of intent.folders) {
    if (samePath(folder.node.worktree_path, intent.path)) continue;
    // The journal records verified legacy ownership before any folder is removed.
    if (existsSync(folder.node.worktree_path)) {
      await assertGitState(folder.node.worktree_path, folder.before);
      await assertWorktreeUnlocked(folder.node.worktree_path);
      if ((await status(folder.node.worktree_path)).length)
        throw new OperationConflict('A folder changed during conversion. Work preserved.');
      await preserveLocalFiles(store, folder.node, folder.preserved);
      await removeDisposableFiles(folder.node.worktree_path, folder.disposable);
      if (
        (await status(folder.node.worktree_path)).length ||
        (await ignoredPaths(folder.node.worktree_path)).length
      )
        throw new OperationConflict('Local files changed during conversion. Work preserved.');
    }
    await removeWorktree(project.repo_path, folder.node.worktree_path);
    store.markArchived(folder.node.id);
  }
  const root = store.getNode(intent.nodeId)!;
  const reused = intent.folders.find((folder) => samePath(folder.node.worktree_path, intent.path));
  if (existsSync(intent.path)) {
    const actual = await readGitState(intent.path);
    const expected = reused?.before ?? {
      ...(await expectedGitState(project.repo_path, root)),
      branch: null,
    };
    if (
      !samePath(actual.commonDir, expected.commonDir) ||
      actual.head !== expected.head ||
      (actual.branch !== expected.branch && actual.branch !== null) ||
      (await status(intent.path)).length
    )
      throw new OperationConflict('The workspace changed during conversion. Work preserved.');
    await git(['checkout', '--detach', '--no-overwrite-ignore', tipOf(root)!], intent.path);
  } else if (reused)
    throw new OperationConflict(
      'The selected source checkout disappeared during conversion. Restore it before retrying.',
    );
  else await addDetachedWorktree(project.repo_path, intent.path, tipOf(root)!);
  if (!store.workspaces.get(project.id)) store.workspaces.create(project.id, intent.path);
  store.workspaces.configure(project.id, intent.rebuildPaths);
  store.workspaces.activate(project.id, root.id, store.projectScratchDir(project.id));
  store.setMetadata(`workspace_migration:${project.id}`, null);
}
