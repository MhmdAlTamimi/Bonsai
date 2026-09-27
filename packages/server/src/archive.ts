import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArchiveCheck, StorageView } from '@bonsai/shared';

import type { EventBus } from './api/events.js';
import type { NodeRow, Store } from './db/store.js';
import { OperationConflict } from './domain/errors.js';
import { ignoredPaths, status } from './git/exec.js';
import { removeWorktree } from './git/worktree.js';
import type { Logger } from './log.js';
import { ownsWorktree } from './projects.js';

/**
 * Archiving an experiment: removing its folder to save space, and nothing
 * else.
 *
 * The folder is the only part of an experiment that is expensive to keep --
 * a full checkout, usually with its dependencies installed -- and the only
 * part that can be made again. The branch holds every commit, the database
 * holds the conversation and the runs, and Claude keeps its session. The next
 * run (or Open folder) checks the branch out again at the same path, which
 * matters because the session is found by that path, and runs setup again.
 *
 * So what archiving must never do is lose something that cannot be made
 * again: work no run has committed, a folder that is the user's own, a run in
 * progress. And what it asks about first is ignored files that are not
 * dependencies or build output -- a local .env, a scratch database -- because
 * those go with the folder.
 */

/** Ignored folders that setup or a build makes again: dependencies, caches, output. */
const REBUILT_DIRS = new Set([
  'node_modules',
  'bower_components',
  '.pnpm-store',
  '.yarn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.angular',
  '.turbo',
  '.parcel-cache',
  '.vite',
  '.cache',
  'coverage',
  '.nyc_output',
  'target',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.venv',
  'venv',
  '.gradle',
  '.dart_tool',
  'vendor',
]);

/** Ignored files that are only ever a by-product. */
const REBUILT_FILE = /(^|\/)(\.DS_Store|Thumbs\.db)$|\.(pyc|pyo|log|tsbuildinfo)$/;

/**
 * Whether an ignored path is something setup, a build or Bonsai itself puts
 * back. Copy-in files count: they are copied from the project's folder again
 * when the experiment's folder is created.
 */
export function isRebuilt(path: string, copyFiles: readonly string[]): boolean {
  const trimmed = path.replace(/\/$/, '');
  if (copyFiles.includes(trimmed)) return true;
  if (trimmed.split('/').some((part) => REBUILT_DIRS.has(part) || part.endsWith('.egg-info')))
    return true;
  return REBUILT_FILE.test(trimmed);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether an experiment's folder can be archived now. `busy` is the jobs
 * runner's view -- a queued run has not changed the node's status yet.
 */
export async function archiveCheck(
  store: Store,
  node: NodeRow,
  busy: boolean,
): Promise<ArchiveCheck> {
  const blocked = (reason: string): ArchiveCheck => ({ blocked: reason, ignored: [] });
  const project = store.getProject(node.project_id);
  if (project === undefined) return blocked('No such project.');
  if (node.archived_at !== null) return blocked('Its folder is already archived.');
  if (node.worktree_allocated === 0) return blocked('It has no folder yet.');
  if (!ownsWorktree(project, node))
    return blocked('This is your own folder. Bonsai never removes it.');
  if (busy || node.status === 'running' || node.status === 'needs_you')
    return blocked('It is running. Archive it once it stops.');
  // Gone already (removed by hand, say): archiving only records that.
  if (!(await exists(node.worktree_path))) return { blocked: null, ignored: [] };
  const dirty = await status(node.worktree_path);
  if (dirty.length > 0)
    return blocked(
      `It has changes no run has committed (${dirty.length === 1 ? '1 file' : `${dirty.length} files`}). Resume or discard them first.`,
    );
  const copyFiles = store.projectView(project).setup.copyFiles;
  const ignored = (await ignoredPaths(node.worktree_path)).filter(
    (path) => !isRebuilt(path, copyFiles),
  );
  return { blocked: null, ignored };
}

/**
 * Removes the folder and records it. Call inside `jobs.whileIdle` so no run
 * can start on the folder while it goes.
 *
 * `removeIgnored` is the user having seen the list of ignored files that go
 * with it; without it, a folder that has any is refused.
 */
export async function archiveFolder(
  store: Store,
  node: NodeRow,
  removeIgnored: boolean,
): Promise<void> {
  const check = await archiveCheck(store, node, false);
  if (check.blocked !== null) throw new OperationConflict(check.blocked);
  if (check.ignored.length > 0 && !removeIgnored)
    throw new OperationConflict(
      `Archiving would delete ignored files that the next run cannot bring back: ${check.ignored.join(', ')}`,
    );
  const project = store.getProject(node.project_id)!;
  await removeWorktree(project.repo_path, node.worktree_path);
  store.markArchived(node.id);
}

/** Bytes a folder takes on disk. Symlinks are counted as links, never followed. */
async function folderBytes(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const batch = pending.splice(0, 64);
    await Promise.all(
      batch.map(async (dir) => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        await Promise.all(
          entries.map(async (entry) => {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
              pending.push(path);
              return;
            }
            try {
              const info = await lstat(path);
              // Blocks, where the platform reports them, are what the disk
              // actually gives up; size is the fallback (Windows).
              total += info.blocks > 0 ? info.blocks * 512 : info.size;
            } catch {
              // Gone while walking: nothing to count.
            }
          }),
        );
      }),
    );
  }
  return total;
}

/**
 * What the experiment folders Bonsai made take up, by project. Your own
 * folder is not counted: archiving can never free it.
 */
export async function storageUse(store: Store): Promise<StorageView> {
  const projects: StorageView['projects'] = [];
  for (const project of store.listProjects()) {
    let folders = 0;
    let bytes = 0;
    let archived = 0;
    for (const node of store.listNodes(project.id)) {
      if (node.archived_at !== null) archived += 1;
      if (node.worktree_allocated === 0 || !ownsWorktree(project, node)) continue;
      folders += 1;
      bytes += await folderBytes(node.worktree_path);
    }
    projects.push({ id: project.id, name: project.name, folders, bytes, archived });
  }
  return {
    folders: projects.reduce((n, p) => n + p.folders, 0),
    bytes: projects.reduce((n, p) => n + p.bytes, 0),
    archived: projects.reduce((n, p) => n + p.archived, 0),
    projects,
  };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Archives folders that have been idle longer than the setting, once an hour.
 *
 * Only the ones that are safe without asking: nothing uncommitted, nothing
 * running, and no ignored files beyond dependencies and build output. Anything
 * else stays until the user archives it by hand.
 */
export class ArchiveSweeper {
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly deps: {
      store: Store;
      bus: EventBus;
      log: Logger;
      jobs: {
        isRunning(nodeId: string): boolean;
        whileIdle<T>(nodeId: string, work: () => Promise<T>): Promise<T>;
      };
      settings: { archiveAfterDays(): number | null };
    },
  ) {}

  start(): void {
    // A minute after starting, so launching the app does not compete with it.
    const first = setTimeout(() => void this.sweep(), 60_000);
    first.unref();
    this.timer = setInterval(() => void this.sweep(), HOUR);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Returns the ids it archived. */
  async sweep(now = Date.now()): Promise<string[]> {
    const days = this.deps.settings.archiveAfterDays();
    if (days === null || this.sweeping) return [];
    this.sweeping = true;
    const { store, bus, log, jobs } = this.deps;
    const archived: string[] = [];
    try {
      for (const project of store.listProjects()) {
        const lastActive = store.lastActive(project.id);
        let changed = false;
        for (const node of store.listNodes(project.id)) {
          if (node.worktree_allocated === 0 || jobs.isRunning(node.id)) continue;
          const since = Date.parse(lastActive.get(node.id) ?? node.created_at);
          if (!Number.isFinite(since) || now - since < days * DAY) continue;
          try {
            const done = await jobs.whileIdle(node.id, async () => {
              const fresh = store.getNode(node.id);
              if (fresh === undefined) return false;
              const check = await archiveCheck(store, fresh, false);
              if (check.blocked !== null || check.ignored.length > 0) return false;
              await archiveFolder(store, fresh, false);
              return true;
            });
            if (done) {
              archived.push(node.id);
              changed = true;
            }
          } catch (error) {
            log.warn('archive.skipped', {
              nodeId: node.id,
              projectId: project.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (changed) bus.publish(project.id, { type: 'tree.updated', projectId: project.id });
      }
      if (archived.length > 0) log.info('archive.swept', { archived: archived.length, days });
      return archived;
    } finally {
      this.sweeping = false;
    }
  }
}
