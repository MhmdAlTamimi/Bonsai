import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { copyFile, cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Store, NodeRow } from '../db/store.js';
import { OperationConflict } from '../domain/errors.js';
import { git, ignoredPaths, status } from '../git/exec.js';
import { assertGitState, expectedGitState, readGitState, type GitState } from '../git/ownership.js';
import { pinNode, tipOf } from '../git/refs.js';
import { rejectPath, seedFiles, type SeedFileOutcome } from '../git/seedWorktree.js';
import { initialiseSubmodules } from '../git/submodules.js';
import { addDetachedWorktree, assertWorktreeUnlocked, removeWorktree } from '../git/worktree.js';
import { isInside, samePath } from '../paths.js';
import { stopLeftovers } from './leftovers.js';
import { fingerprint } from '../storage/fingerprint.js';

const ownership = new AsyncLocalStorage<ReadonlySet<string>>();

/** Cross-process exclusion, held through agent/process cleanup and durable saving. */
export async function withProjectWorkspace<T>(
  store: Store,
  projectId: string,
  work: () => Promise<T>,
  force = false,
): Promise<T> {
  if ((!force && !store.workspaces.get(projectId)) || ownership.getStore()?.has(projectId))
    return work();
  const scratch = store.projectScratchDir(projectId);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  // Use an OS-backed SQLite lock, like the application instance lock. Process death
  // releases it without PID heuristics or races between stale-lock removers.
  const lockPath = join(dirname(scratch), '.workspace-locks', `${projectId}.db`);
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(lockPath);
  try {
    chmodSync(lockPath, 0o600);
    lock.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
    return await ownership.run(new Set([...(ownership.getStore() ?? []), projectId]), work);
  } catch (error) {
    if (error instanceof Error && /database is locked|database is busy/i.test(error.message))
      throw new OperationConflict(
        'This project’s workspace is in use by another Bonsai operation. Retry when it finishes.',
      );
    throw error;
  } finally {
    lock.close();
  }
}

/** Settings paths are literal repository-relative directories, never glob or shell patterns. */
export function validateRebuildPaths(paths: readonly string[]): string[] {
  return [
    ...new Set(
      paths.map((raw) => {
        const path = raw.trim().replace(/\\/g, '/').replace(/\/$/, '');
        if (
          !path ||
          isAbsolute(path) ||
          /^[A-Za-z]:/.test(path) ||
          path
            .split('/')
            .some(
              (part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git',
            ) ||
          /[\0\r\n*?[\]]/.test(path)
        )
          throw new OperationConflict(
            'Regeneratable folders must be literal paths inside the repository, such as node_modules or .venv.',
          );
        return path;
      }),
    ),
  ];
}

export interface WorkspaceSwitch {
  id: string;
  nodeId: string;
  target: string;
  generation: number;
  sourceNodeId: string | null;
  before: GitState | null;
  preserved: string[];
  disposable: string[];
  restore: string[];
  stage: 'preserve' | 'checkout' | 'restore';
  release?: boolean;
}

export function localFilesDir(store: Store, projectId: string, nodeId: string): string {
  return join(store.projectScratchDir(projectId), 'local-files', nodeId);
}

async function manifest(root: string): Promise<string[]> {
  return JSON.parse(
    await readFile(join(root, 'manifest.json'), 'utf8').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '[]';
      throw error;
    }),
  ) as string[];
}

export async function checkedPath(root: string, path: string): Promise<string> {
  // These are literal filenames from Git, not settings patterns. Preserve spaces,
  // brackets and other legal names without trimming or rewriting their identity.
  if (
    !path ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\0') ||
    path
      .split(/[\\/]/)
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  )
    throw new OperationConflict('Local file path leaves the workspace. Files preserved.');
  const safe = path;
  const full = resolve(root, safe);
  if (
    (
      await lstat(root).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      })
    )?.isSymbolicLink()
  )
    throw new OperationConflict('The workspace root is a symlink. Files preserved.');
  if (!isInside(root, full) || samePath(root, full))
    throw new OperationConflict('Local file path leaves the workspace. Files preserved.');
  // Parent symlinks can make even a relative path leave the owned folder.
  let parent = dirname(full);
  while (!samePath(parent, root)) {
    const info = await lstat(parent).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink())
      throw new OperationConflict('A local file path contains a symlink. Files preserved.');
    parent = dirname(parent);
  }
  return full;
}

export async function removeDisposableFiles(root: string, paths: readonly string[]): Promise<void> {
  for (const path of paths)
    await rm(await checkedPath(root, path), { recursive: true, force: true });
}

export async function moveLocal(fromRoot: string, toRoot: string, path: string): Promise<void> {
  const from = await checkedPath(fromRoot, path);
  const to = await checkedPath(toRoot, path);
  const source = await lstat(from).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  const destination = await lstat(to).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!source && destination) return; // Recorded move finished before a crash.
  if (
    source &&
    destination &&
    (await fingerprint(from, 'local')) === (await fingerprint(to, 'local'))
  ) {
    await rm(from, { recursive: true }); // Verified cross-device copy finished before a crash.
    return;
  }
  if (!source || destination)
    throw new OperationConflict(
      `Local files at ${path} changed during switching. Files preserved.`,
    );
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    const temporary = `${to}.bonsai-${randomUUID()}.tmp`;
    try {
      const digest = await fingerprint(from, 'local');
      await cp(from, temporary, { recursive: true, dereference: false, preserveTimestamps: true });
      if (
        (await fingerprint(temporary, 'local')) !== digest ||
        (await fingerprint(from, 'local')) !== digest
      )
        throw new OperationConflict(
          'Local files changed during preservation. The source was kept.',
        );
      await rename(temporary, to);
      await rm(from, { recursive: true });
    } catch (copyError) {
      await rm(temporary, { recursive: true, force: true });
      throw copyError;
    }
  }
}

async function cleanSubmodules(path: string): Promise<void> {
  // Worktrees do not isolate nested submodule state from a checkout transition.
  const result = await git(
    ['submodule', 'foreach', '--quiet', '--recursive', 'git status --porcelain --ignored'],
    path,
  );
  if (result.trim())
    throw new OperationConflict(
      'A submodule has local or ignored files. Preserve or clean those files before switching experiments.',
    );
}

export async function preserveLocalFiles(
  store: Store,
  node: Pick<NodeRow, 'id' | 'project_id' | 'worktree_path'>,
  paths: readonly string[],
): Promise<void> {
  const root = localFilesDir(store, node.project_id, node.id);
  await mkdir(join(root, 'files'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'manifest.json'), JSON.stringify(paths), { mode: 0o600 });
  for (const path of paths) await moveLocal(node.worktree_path, join(root, 'files'), path);
}

/** Used only under workspace ownership. Unknown ignored data stays node-scoped. */
export async function activateWorkspace(store: Store, stale: NodeRow): Promise<SeedFileOutcome[]> {
  return withProjectWorkspace(store, stale.project_id, async () => {
    let workspace = store.workspaces.get(stale.project_id)!;
    const project = store.getProject(stale.project_id)!;
    const node = store.getNode(stale.id)!;
    await stopNodeLeftovers(store, node.id);
    if (workspace.active_node_id && workspace.active_node_id !== node.id)
      await stopNodeLeftovers(store, workspace.active_node_id);
    if (store.metadata(`workspace_recovery:${project.id}`))
      throw new OperationConflict(
        'Finish workspace recovery in Project settings before running experiments.',
      );
    if (store.metadata(`workspace_migration:${project.id}`))
      throw new OperationConflict(
        'Finish this project’s workspace conversion in Project settings before running experiments.',
      );
    if (store.deletions.pending().some((intent) => intent.project.id === project.id))
      throw new OperationConflict(
        'Finish or cancel this project’s pending deletion before using its workspace.',
      );
    if (store.saves.pending().some((save) => save.projectId === project.id))
      throw new OperationConflict(
        'This project has an unfinished code save. Recover it before switching experiments.',
      );
    await pinNode(project.repo_path, node);
    if (workspace.switch_json) {
      const pending = JSON.parse(workspace.switch_json) as WorkspaceSwitch;
      await finishSwitch(store, pending);
      workspace = store.workspaces.get(project.id)!;
    }
    if (workspace.active_node_id === node.id) {
      if (!existsSync(workspace.path))
        throw new OperationConflict(
          'The active workspace folder is missing. Restore a backup or use explicit synchronization; Bonsai will not silently recreate it.',
        );
      await assertGitState(
        workspace.path,
        await expectedGitState(project.repo_path, store.getNode(node.id)!),
      );
      Object.assign(stale, store.getNode(node.id)!);
      return seedMissingFiles(store, stale);
    }
    if (workspace.held)
      throw new OperationConflict(
        'The workspace is kept on another experiment. Release “Keep active” before switching.',
      );
    const target = tipOf(node)!;
    const source =
      workspace.active_node_id === null ? null : store.getNode(workspace.active_node_id)!;
    let before: GitState | null = null;
    let ignored: string[] = [];
    if (source) {
      await assertGitState(workspace.path, await expectedGitState(project.repo_path, source));
      await assertWorktreeUnlocked(workspace.path);
      if ((await status(workspace.path)).length)
        throw new OperationConflict(
          `${source.display_name} has unfinished changes. Resume, save/import, or explicitly discard them before switching experiments.`,
        );
      await cleanSubmodules(workspace.path);
      before = await readGitState(workspace.path);
      ignored = (await ignoredPaths(workspace.path)).map((path) => path.replace(/\/$/, ''));
    } else if (existsSync(workspace.path)) {
      throw new OperationConflict(
        'An unexpected folder occupies the workspace. Files preserved; inspect it before continuing.',
      );
    }
    const rebuild = validateRebuildPaths(JSON.parse(workspace.rebuild_paths) as string[]);
    const disposable = ignored.filter((path) =>
      rebuild.some((root) => path === root || path.startsWith(`${root}/`)),
    );
    const preserved = ignored.filter((path) => !disposable.includes(path));
    const saved = await manifest(localFilesDir(store, project.id, node.id));
    if (
      source &&
      project.source_kind === 'created' &&
      samePath(project.source_path ?? '', workspace.path)
    )
      await snapshotCopyIn(store, source);
    const intent: WorkspaceSwitch = {
      id: randomUUID(),
      nodeId: node.id,
      target,
      generation: workspace.generation,
      sourceNodeId: source?.id ?? null,
      before,
      preserved,
      disposable,
      restore: saved,
      stage: 'preserve',
    };
    store.workspaces.journal(project.id, intent);
    await finishSwitch(store, intent);
    Object.assign(stale, store.getNode(node.id)!);
    return seedMissingFiles(store, stale);
  });
}

async function finishSwitch(store: Store, intent: WorkspaceSwitch): Promise<void> {
  const node = store.getNode(intent.nodeId);
  if (!node)
    throw new OperationConflict('The target experiment no longer exists. Switch recovery blocked.');
  const project = store.getProject(node.project_id)!;
  const workspace = store.workspaces.get(project.id)!;
  if (
    workspace.generation !== intent.generation ||
    workspace.active_node_id !== intent.sourceNodeId ||
    tipOf(node) !== intent.target
  )
    throw new OperationConflict('Experiment ownership changed during switching. Work preserved.');
  await pinNode(project.repo_path, node);
  if (intent.sourceNodeId) await pinNode(project.repo_path, store.getNode(intent.sourceNodeId)!);
  const saveJournal = () => store.workspaces.journal(project.id, intent);
  if (intent.stage === 'preserve') {
    if (intent.before) {
      await assertGitState(workspace.path, intent.before);
      if ((await status(workspace.path)).length)
        throw new OperationConflict('The workspace changed during switching. Work preserved.');
      const root = localFilesDir(store, project.id, intent.sourceNodeId!);
      const files = join(root, 'files');
      await mkdir(files, { recursive: true, mode: 0o700 });
      // Manifest precedes moves so restart can finish a partially moved ignored tree.
      await writeFile(join(root, 'manifest.json'), JSON.stringify(intent.preserved), {
        mode: 0o600,
      });
      for (const path of intent.preserved) await moveLocal(workspace.path, files, path);
      await removeDisposableFiles(workspace.path, intent.disposable);
    }
    intent.stage = 'checkout';
    saveJournal();
  }
  if (intent.stage === 'checkout') {
    if (intent.release) {
      if (existsSync(workspace.path)) {
        await assertGitState(workspace.path, intent.before!);
        if ((await status(workspace.path)).length || (await ignoredPaths(workspace.path)).length)
          throw new OperationConflict(
            'Local files changed while releasing working space. Files preserved.',
          );
      }
      await removeWorktree(project.repo_path, workspace.path);
      store.workspaces.activate(project.id, null, store.projectScratchDir(project.id));
      return;
    }
    if (!intent.before) {
      if (!existsSync(workspace.path))
        await addDetachedWorktree(project.repo_path, workspace.path, intent.target);
      else {
        const actual = await readGitState(workspace.path);
        const expected = await expectedGitState(project.repo_path, node);
        await assertGitState(workspace.path, { ...expected, branch: null });
        if (actual.branch !== null || (await status(workspace.path)).length)
          throw new OperationConflict('Unexpected files in the new workspace. Files preserved.');
      }
    } else {
      const actual = await readGitState(workspace.path);
      if (
        !samePath(actual.commonDir, intent.before.commonDir) ||
        ![intent.before.head, intent.target].includes(actual.head) ||
        (actual.head === intent.before.head &&
          actual.branch !== intent.before.branch &&
          actual.branch !== null) ||
        (await status(workspace.path)).length
      )
        throw new OperationConflict(
          'Git changed outside the recorded workspace switch. Files preserved.',
        );
      if ((await ignoredPaths(workspace.path)).length)
        throw new OperationConflict(
          'Ignored files appeared during switching. Files preserved; use workspace recovery in Project settings.',
        );
      // Clean nested checkouts can outlive a removed gitlink. Deinitialize
      // before switching so a deleted/renamed submodule cannot leak into the target.
      await cleanSubmodules(workspace.path);
      if (existsSync(join(workspace.path, '.gitmodules')))
        await git(['submodule', 'deinit', '--all'], workspace.path);
      // --no-overwrite-ignore protects ignored collisions, unlike Git's default checkout.
      await git(['checkout', '--detach', '--no-overwrite-ignore', intent.target], workspace.path);
      await initialiseSubmodules(workspace.path);
    }
    intent.stage = 'restore';
    saveJournal();
  }
  await assertGitState(workspace.path, {
    ...(await expectedGitState(project.repo_path, node)),
    branch: null,
  });
  const remaining = (await ignoredPaths(workspace.path)).map((path) => path.replace(/\/$/, ''));
  if (
    remaining.some(
      (path) => !intent.restore.some((root) => path === root || path.startsWith(`${root}/`)),
    )
  )
    throw new OperationConflict(
      'Unexpected local files appeared during preparation. Files preserved; use workspace recovery in Project settings.',
    );
  for (const path of intent.restore) {
    // The preserved destination must still be ignored in this exact code snapshot.
    const files = join(localFilesDir(store, project.id, node.id), 'files');
    const info = await lstat(join(files, path)).catch(() => lstat(join(workspace.path, path)));
    await git(['check-ignore', '-q', '--', info.isDirectory() ? `${path}/` : path], workspace.path);
    await moveLocal(files, workspace.path, path);
  }
  store.workspaces.activate(project.id, node.id, store.projectScratchDir(project.id));
}

async function seedMissingFiles(store: Store, node: NodeRow): Promise<SeedFileOutcome[]> {
  const project = store.getProject(node.project_id)!;
  if (project.source_path === null) return [];
  const source =
    project.source_kind === 'created' && samePath(project.source_path, node.worktree_path)
      ? join(store.projectScratchDir(project.id), 'copy-in')
      : project.source_path;
  const files = store
    .projectView(project)
    .setup.copyFiles.filter((path) => !existsSync(join(node.worktree_path, path)));
  return seedFiles({
    sourceDir: source,
    sourceRepoPath: project.repo_path,
    targetDir: node.worktree_path,
    files,
  });
}

async function snapshotCopyIn(store: Store, node: NodeRow): Promise<void> {
  const project = store.getProject(node.project_id)!;
  const root = join(store.projectScratchDir(project.id), 'copy-in');
  for (const path of store.projectView(project).setup.copyFiles) {
    if (rejectPath(path))
      throw new OperationConflict('Unsafe copy-in file. Update Project settings.');
    const from = await checkedPath(node.worktree_path, path);
    const to = await checkedPath(root, path);
    if (existsSync(to) || !existsSync(from)) continue;
    if (!(await lstat(from)).isFile())
      throw new OperationConflict('Copy-in files must be ordinary files.');
    if ((await git(['ls-files', '--', path], node.worktree_path)).trim())
      throw new OperationConflict('A configured copy-in file is tracked. Update Project settings.');
    await git(['check-ignore', '-q', '--', path], node.worktree_path);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await copyFile(from, to);
    chmodSync(to, 0o600);
  }
}

export async function recoverWorkspaceSwitches(store: Store): Promise<void> {
  for (const project of store.listProjects()) {
    const workspace = store.workspaces.get(project.id);
    if (!workspace?.switch_json) continue;
    if (store.metadata(`workspace_recovery:${project.id}`)) continue;
    await withProjectWorkspace(store, project.id, () =>
      finishSwitch(store, JSON.parse(workspace.switch_json!) as WorkspaceSwitch),
    );
  }
}

export async function retryWorkspaceSwitch(store: Store, projectId: string): Promise<void> {
  const workspace = store.workspaces.get(projectId);
  if (!workspace?.switch_json) return;
  await withProjectWorkspace(store, projectId, () =>
    finishSwitch(store, JSON.parse(workspace.switch_json!) as WorkspaceSwitch),
  );
}

export async function releaseWorkspace(store: Store, node: NodeRow): Promise<void> {
  return withProjectWorkspace(store, node.project_id, async () => {
    const workspace = store.workspaces.get(node.project_id)!;
    assertWorkspaceOwner(store, node);
    if (workspace.held)
      throw new OperationConflict('Release “Keep active” before freeing working space.');
    if (store.saves.pending().some((save) => save.projectId === node.project_id))
      throw new OperationConflict('Recover this project’s unfinished save first.');
    const project = store.getProject(node.project_id)!;
    await stopNodeLeftovers(store, node.id);
    if (project.source_kind === 'created' && samePath(project.source_path ?? '', workspace.path))
      await snapshotCopyIn(store, node);
    await assertGitState(workspace.path, await expectedGitState(project.repo_path, node));
    await assertWorktreeUnlocked(workspace.path);
    if ((await status(workspace.path)).length)
      throw new OperationConflict(
        'Save or discard unfinished changes before freeing working space.',
      );
    await cleanSubmodules(workspace.path);
    const ignored = (await ignoredPaths(workspace.path)).map((path) => path.replace(/\/$/, ''));
    const rebuild = validateRebuildPaths(JSON.parse(workspace.rebuild_paths) as string[]);
    const disposable = ignored.filter((path) =>
      rebuild.some((root) => path === root || path.startsWith(`${root}/`)),
    );
    const intent: WorkspaceSwitch = {
      id: randomUUID(),
      nodeId: node.id,
      target: tipOf(node)!,
      generation: workspace.generation,
      sourceNodeId: node.id,
      before: await readGitState(workspace.path),
      preserved: ignored.filter((path) => !disposable.includes(path)),
      disposable,
      restore: [],
      stage: 'preserve',
      release: true,
    };
    store.workspaces.journal(node.project_id, intent);
    await finishSwitch(store, intent);
  });
}

export async function stopNodeLeftovers(store: Store, nodeId: string): Promise<void> {
  const last = store
    .listRuns(nodeId)
    .filter((run) => run.status === 'failed' || run.status === 'cancelled')
    .at(-1);
  if (last) await stopLeftovers(last.id);
}

export function assertWorkspaceOwner(store: Store, node: NodeRow, generation?: number): void {
  const workspace = store.workspaces.get(node.project_id);
  if (
    workspace &&
    (workspace.switch_json ||
      workspace.active_node_id !== node.id ||
      !samePath(workspace.path, node.worktree_path) ||
      (generation !== undefined && workspace.generation !== generation))
  )
    throw new OperationConflict(
      'The workspace belongs to another experiment or is switching. Work preserved.',
    );
}
