import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { Store } from '../db/store.js';
import type { Logger } from '../log.js';
import type { Settings } from '../settings.js';
import { isInside, samePath, canonicalPath } from '../paths.js';
import { OperationConflict } from '../domain/errors.js';
import { git, gitLine } from '../git/exec.js';
import { commitExists } from '../git/repo.js';
import { nodeRef, projectRefs, tipOf } from '../git/refs.js';

interface Move {
  projectId: string;
  roots: Array<{ from: string; to: string }>;
}

const mapper =
  (move: Move) =>
  (path: string): string => {
    // Most-specific first: an external source can enclose an owned scratch folder.
    const root = [...move.roots]
      .sort((a, b) => b.from.length - a.from.length)
      .find((root) => isInside(root.from, path));
    return root ? join(root.to, relative(root.from, path)) : path;
  };

/** Verify repository identity and every checkout before repairing any administration. */
async function applyMove(store: Store, move: Move): Promise<void> {
  const project = store.getProject(move.projectId);
  if (!project) throw new OperationConflict('The project no longer exists.');
  const map = mapper(move);
  const repo = map(project.repo_path);
  const nodes = store.listNodes(project.id);
  const common = await canonicalPath(
    await gitLine(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo),
  );
  const refs = await projectRefs(repo, project.id);
  if (!nodes.some((node) => refs.has(nodeRef(project.id, node.id))))
    throw new OperationConflict(
      'This repository has no saved Git identity for this Bonsai project. Restore a complete backup instead.',
    );
  for (const node of nodes) {
    const tip = tipOf(node);
    if (tip !== null && !(await commitExists(repo, tip)))
      throw new OperationConflict(
        `The selected repository is missing recorded code for ${node.display_name}. Its files were not changed.`,
      );
  }
  const oldCommon = samePath(project.repo_path, repo)
    ? common
    : join(project.repo_path, relative(repo, common));
  const repair: string[] = [];
  for (const node of nodes) {
    const path = map(node.worktree_path);
    if (
      !existsSync(path) ||
      (samePath(path, project.source_path ?? '') && project.source_kind === 'adopted')
    )
      continue;
    if (node.worktree_allocated === 0)
      throw new OperationConflict(
        `Unexpected folder at ${path}. Preserve/import it before relocating the project.`,
      );
    const marker = await readFile(join(path, '.git'), 'utf8').catch(() => '');
    const prefix = 'gitdir: ';
    if (!marker.startsWith(prefix))
      throw new OperationConflict(
        `The folder at ${path} is not a recorded Bonsai worktree. It was preserved.`,
      );
    const admin = resolve(path, marker.slice(prefix.length).trim());
    // Only an administration entry in this project's old or new repository is ours.
    if (![oldCommon, common].some((root) => isInside(join(root, 'worktrees'), admin)))
      throw new OperationConflict(
        `The folder at ${path} belongs to a different repository. It was preserved.`,
      );
    if (
      !samePath(path, node.worktree_path) &&
      existsSync(node.worktree_path) &&
      samePath(project.repo_path, repo)
    )
      throw new OperationConflict(
        'The original Bonsai checkout still exists in this shared repository. Close its Bonsai instance and move the original data folder before repairing this copy.',
      );
    repair.push(path);
  }
  // This explicit/verified choice survives a crash during Git's repair operation.
  store.setMetadata(`relocation:${project.id}`, JSON.stringify(move));
  if (repair.length > 0) await git(['worktree', 'repair', ...repair], repo);
  store.remapProjectPaths(project.id, map);
}

/** Repair only paths that came along with Bonsai's data folder. Never guess an external move. */
export async function relocateManagedStorage(
  store: Store,
  dataDir: string,
  log: Logger,
  settings?: Settings,
): Promise<void> {
  let oldRoot = store.metadata('data_root');
  if (oldRoot === null) {
    const roots = new Set(
      store.listProjects().flatMap((project) => {
        const scratch = project.scratch_path;
        return scratch !== null &&
          basename(scratch) === project.id &&
          basename(dirname(scratch)) === 'repos'
          ? [dirname(dirname(scratch))]
          : [];
      }),
    );
    if (roots.size === 1) oldRoot = [...roots][0]!;
  }
  if (oldRoot !== null && !samePath(oldRoot, dataDir))
    settings?.relocateStorageRoot(oldRoot, dataDir);
  for (const project of store.listProjects()) {
    const pending = store.metadata(`relocation:${project.id}`);
    try {
      if (pending !== null) {
        await applyMove(store, JSON.parse(pending) as Move);
        continue;
      }
      if (oldRoot === null || samePath(oldRoot, dataDir)) continue;
      const scratch = store.projectScratchDir(project.id);
      if (!isInside(oldRoot, scratch)) continue;
      const moved = join(dataDir, relative(oldRoot, scratch));
      if (!existsSync(moved)) continue;
      const move: Move = { projectId: project.id, roots: [{ from: scratch, to: moved }] };
      const movedRepo = mapper(move)(project.repo_path);
      if (!existsSync(movedRepo)) {
        // Record the owned paths now; Locate repository will repair the worktrees later.
        store.remapProjectPaths(project.id, mapper(move));
      } else await applyMove(store, move);
      log.info('project.storage_relocated', { projectId: project.id });
    } catch (error) {
      log.warn('project.storage_relocation_blocked', {
        projectId: project.id,
        error: String(error),
      });
    }
  }
  // Failed projects retain their own relocation intent or original paths; do not lose
  // the old root needed to retry a blocked automatic relocation.
  if (
    !store
      .listProjects()
      .some(
        (project) =>
          oldRoot !== null &&
          !samePath(oldRoot, dataDir) &&
          isInside(oldRoot, store.projectScratchDir(project.id)),
      )
  )
    store.setMetadata('data_root', resolve(dataDir));
}

/** User chooses the moved repository. Known tips and hidden project refs prove identity. */
export async function locateRepository(
  store: Store,
  projectId: string,
  selected: string,
): Promise<void> {
  const project = store.getProject(projectId);
  if (!project) throw new OperationConflict('The project no longer exists.');
  if (store.deletions.pending().some((intent) => intent.project.id === projectId))
    throw new OperationConflict('Finish or cancel the pending deletion first.');
  const bare = await gitLine(['rev-parse', '--is-bare-repository'], selected);
  const repo = await canonicalPath(
    bare === 'true' ? selected : await gitLine(['rev-parse', '--show-toplevel'], selected),
  );
  if (existsSync(project.repo_path) && !samePath(project.repo_path, repo))
    throw new OperationConflict(
      'The recorded repository still exists. Move it first; Bonsai will not replace a working repository with another copy.',
    );
  const roots = [{ from: project.repo_path, to: repo }];
  // Private created repositories carry their scratch folder when moved together.
  const scratch = store.projectScratchDir(projectId);
  if (samePath(dirname(project.repo_path), scratch) && !samePath(dirname(repo), scratch))
    roots.unshift({ from: scratch, to: dirname(repo) });
  await applyMove(store, { projectId, roots });
}
