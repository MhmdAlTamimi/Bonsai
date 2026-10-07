import { fingerprint } from './fingerprint.js';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import type { Store } from '../db/store.js';
import { openDatabase } from '../db/open.js';
import { Store as BackupStore } from '../db/store.js';
import type { Settings } from '../settings.js';
import { OperationConflict } from '../domain/errors.js';
import { git, gitLine } from '../git/exec.js';
import { copyWorkingFiles } from '../git/export.js';
import { isInside, samePath } from '../paths.js';
import { lostExperiments } from './orphans.js';
import { MODULE_CACHE_FILE, type ModuleCache } from '../git/submodules.js';
import { commitExists } from '../git/repo.js';
import { tipOf } from '../git/refs.js';

interface Root {
  from: string;
  to: string;
}
const mapper =
  (roots: Root[]) =>
  (path: string): string => {
    const root = [...roots]
      .sort((a, b) => b.from.length - a.from.length)
      .find((candidate) => isInside(candidate.from, path));
    return root ? join(root.to, relative(root.from, path)) : path;
  };

const CONFIG_KEYS = [
  'core.repositoryformatversion',
  'core.bare',
  'core.filemode',
  'core.ignorecase',
  'core.symlinks',
  'core.autocrlf',
  'core.safecrlf',
  'core.eol',
  'core.precomposeunicode',
  'core.logallrefupdates',
  'extensions.objectformat',
  'extensions.worktreeconfig',
] as const;

/** Rebuild Git configs without credential helpers, remotes, hooks or arbitrary commands. */
async function safeConfigs(
  source: string,
  target: string,
  map: (path: string) => string,
): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      if (!['objects', 'hooks'].includes(entry.name) && existsSync(to))
        await safeConfigs(from, to, map);
    } else if (entry.name === 'config' || entry.name === 'config.worktree') {
      await writeFile(to, '', { mode: 0o600 });
      for (const key of CONFIG_KEYS) {
        const value = await gitLine(['config', '--file', from, '--get', key], source).catch(
          () => null,
        );
        if (value !== null) await git(['config', '--file', to, key, value], target);
      }
      const worktree = await gitLine(
        ['config', '--file', from, '--get', 'core.worktree'],
        source,
      ).catch(() => null);
      if (worktree !== null)
        await git(
          ['config', '--file', to, 'core.worktree', map(resolve(source, worktree))],
          target,
        );
    }
  }
}

const metadataFilter = (path: string) =>
  !['config', 'config.worktree', 'hooks'].includes(basename(path));

/** Repair nested submodules' pointers without copying or consulting the user's credentials. */
async function repairMarkers(
  originalRoot: string,
  root: string,
  map: (path: string) => string,
  repo: string,
  top: string,
  caches: ModuleCache[],
): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.name === '.git') {
      if (!entry.isFile()) continue;
      const text = await readFile(path, 'utf8');
      if (!text.startsWith('gitdir: '))
        throw new OperationConflict('Invalid Git pointer in backup.');
      const original = resolve(originalRoot, text.slice(8).trim());
      const mapped = map(original);
      if (!isInside(repo, mapped) || !existsSync(mapped))
        throw new OperationConflict(
          `A submodule uses Git data outside the backed-up repository: ${root}`,
        );
      await writeFile(path, `gitdir: ${mapped}\n`);
      await git(['fsck', '--full', '--no-dangling'], root);
      const cache = join(
        repo,
        'bonsai-modules',
        createHash('sha256').update(mapped).digest('hex').slice(0, 20),
      );
      if (!existsSync(cache)) {
        await cp(mapped, cache, { recursive: true, dereference: false, filter: metadataFilter });
        await safeConfigs(mapped, cache, map);
        await git(['--git-dir', cache, 'config', 'core.bare', 'true'], repo);
        await git(['--git-dir', cache, 'config', '--unset-all', 'core.worktree'], repo).catch(
          () => undefined,
        );
      }
      caches.push({
        path: relative(top, originalRoot).split('\\').join('/'),
        gitDir: relative(repo, cache),
      });
    } else if (entry.isDirectory())
      await repairMarkers(join(originalRoot, entry.name), path, map, repo, top, caches);
  }
}

/**
 * A normal, independent Bonsai data folder. The execution pool's idle gate must
 * enclose this operation, including the database snapshot and final validation.
 */
export async function makeBackup(
  store: Store,
  settings: Settings,
  conversationFallbacks = 0,
): Promise<{ path: string; createdAt: string; conversationFallbacks: number }> {
  if (store.deletions.pending().length > 0 || store.saves.pending().length > 0)
    throw new OperationConflict('Finish the pending recovery or deletion before making a backup.');
  for (const project of store.listProjects()) {
    if (store.metadata(`workspace_recovery:${project.id}`))
      throw new OperationConflict('Finish workspace recovery before making a backup.');
    if (
      store.workspaces.get(project.id)?.switch_json ||
      store.metadata(`workspace_migration:${project.id}`)
    )
      throw new OperationConflict(
        'Finish workspace preparation or conversion before making a backup.',
      );
    if (store.metadata(`relocation:${project.id}`) !== null)
      throw new OperationConflict('Finish relocating the project before making a backup.');
    if ((await lostExperiments(store, project.id)).length > 0)
      throw new OperationConflict(
        'Recover the lost experiments in Project settings before making a backup.',
      );
  }
  const dataDir = settings.view().dataDir;
  const backups = join(dataDir, 'backups');
  await mkdir(backups, { recursive: true, mode: 0o700 });
  const path = await mkdtemp(join(backups, 'bonsai-'));
  const createdAt = new Date().toISOString();
  await writeFile(
    join(path, 'backup.json'),
    JSON.stringify({ complete: false, createdAt, conversationFallbacks }, null, 2),
  );
  const roots = new Map<string, Root[]>();
  const checks: Array<{ path: string; digest: string; git: boolean }> = [];
  try {
    store.snapshotDatabase(join(path, 'bonsai.db'));
    for (const project of store.listProjects()) {
      const sourceScratch = store.projectScratchDir(project.id);
      const scratch = join(path, 'repos', project.id);
      const common = await gitLine(
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        project.repo_path,
      );
      const repo = join(scratch, 'repo.git');
      if (existsSync(join(common, 'objects', 'info', 'alternates')))
        throw new OperationConflict(
          'This repository borrows Git objects. Make it independent before backing it up.',
        );
      const projectRoots: Root[] = [
        { from: sourceScratch, to: scratch },
        { from: common, to: repo },
      ];
      const source = project.source_path;
      if (source !== null && isInside(source, path))
        throw new OperationConflict(
          'The project encloses the backup folder. Move Bonsai storage outside that project before backing it up.',
        );
      if (source !== null && !isInside(sourceScratch, source) && existsSync(source))
        projectRoots.push({ from: source, to: join(scratch, 'source') });
      const map = mapper(projectRoots);
      for (const [folder, gitMetadata] of [
        [common, true],
        [sourceScratch, false],
        ...(source !== null && !isInside(sourceScratch, source) && existsSync(source)
          ? [[source, false] as const]
          : []),
      ] as const) {
        if (existsSync(folder))
          checks.push({
            path: folder,
            digest: await fingerprint(folder, gitMetadata ? 'git' : 'working'),
            git: gitMetadata,
          });
      }
      await mkdir(scratch, { recursive: true });
      if (existsSync(sourceScratch)) {
        for (const entry of await readdir(sourceScratch)) {
          if (samePath(join(sourceScratch, entry), common) || entry === '.git') continue;
          await cp(join(sourceScratch, entry), join(scratch, entry), {
            recursive: true,
            dereference: false,
            preserveTimestamps: true,
          });
        }
      }
      // Only recorded worktree administrations belong in this private repository.
      await cp(common, repo, {
        recursive: true,
        dereference: false,
        preserveTimestamps: true,
        filter: (file) => metadataFilter(file) && !isInside(join(common, 'worktrees'), file),
      });
      await mkdir(join(repo, 'worktrees'), { recursive: true });
      for (const node of store.listNodes(project.id)) {
        if (
          !existsSync(node.worktree_path) ||
          (source !== null &&
            samePath(node.worktree_path, source) &&
            !isInside(sourceScratch, source))
        )
          continue;
        if (node.worktree_allocated === 0)
          throw new OperationConflict(
            'An unexpected experiment folder must be recovered before backup.',
          );
        const marker = await readFile(join(node.worktree_path, '.git'), 'utf8');
        if (!marker.startsWith('gitdir: '))
          throw new OperationConflict(
            'An experiment is no longer a Bonsai worktree. Preserve/import it before backup.',
          );
        const admin = resolve(node.worktree_path, marker.slice(8).trim());
        if (!isInside(join(common, 'worktrees'), admin))
          throw new OperationConflict('The experiment belongs to another repository.');
        await cp(admin, map(admin), {
          recursive: true,
          dereference: false,
          preserveTimestamps: true,
          filter: metadataFilter,
        });
        if (!isInside(sourceScratch, node.worktree_path)) {
          const target = join(scratch, 'nodes', node.id);
          projectRoots.push({ from: node.worktree_path, to: target });
          checks.push({
            path: node.worktree_path,
            digest: await fingerprint(node.worktree_path),
            git: false,
          });
          await copyWorkingFiles(node.worktree_path, target);
        }
        await writeFile(join(map(node.worktree_path), '.git'), `gitdir: ${map(admin)}\n`);
        await writeFile(join(map(admin), 'gitdir'), join(map(node.worktree_path), '.git') + '\n');
      }
      if (
        source !== null &&
        isInside(sourceScratch, source) &&
        store.metadata(`backup_source:${project.id}`) === 'true' &&
        existsSync(join(source, '.git'))
      ) {
        const marker = await readFile(join(source, '.git'), 'utf8');
        if (marker.startsWith('gitdir: ')) {
          const admin = resolve(source, marker.slice(8).trim());
          if (!isInside(join(common, 'worktrees'), admin))
            throw new OperationConflict('The backup source belongs to another repository.');
          await cp(admin, map(admin), {
            recursive: true,
            dereference: false,
            filter: metadataFilter,
          });
          await writeFile(join(map(source), '.git'), `gitdir: ${map(admin)}\n`);
          await writeFile(join(map(admin), 'gitdir'), join(map(source), '.git') + '\n');
        }
      }
      await safeConfigs(common, repo, map);
      await git(['config', 'core.bare', 'true'], repo);
      await git(['config', '--unset-all', 'core.worktree'], repo).catch(() => undefined);
      if (source !== null && !isInside(sourceScratch, source) && existsSync(source)) {
        const target = map(source);
        const head = await gitLine(['rev-parse', 'HEAD'], source).catch(() => null);
        if (head !== null) {
          const branch = await gitLine(['branch', '--show-current'], source);
          await git(
            [
              'worktree',
              'add',
              '--no-checkout',
              ...(branch ? [] : ['--detach']),
              target,
              branch || head,
            ],
            repo,
          );
          await copyWorkingFiles(source, target);
          const index = await gitLine(
            ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
            source,
          );
          if (existsSync(index))
            await cp(
              index,
              await gitLine(['rev-parse', '--path-format=absolute', '--git-path', 'index'], target),
            );
        } else await copyWorkingFiles(source, target);
      }
      // Root markers were written above; nested markers still contain original absolute paths.
      const caches: ModuleCache[] = existsSync(join(repo, MODULE_CACHE_FILE))
        ? (JSON.parse(await readFile(join(repo, MODULE_CACHE_FILE), 'utf8')) as ModuleCache[])
        : [];
      for (const cache of caches)
        if (!isInside(repo, resolve(repo, cache.gitDir)))
          throw new OperationConflict('Invalid backup submodule cache.');
      for (const node of store.listNodes(project.id)) {
        const target = map(node.worktree_path);
        if (existsSync(target)) {
          for (const entry of await readdir(target, { withFileTypes: true }))
            if (entry.isDirectory() && entry.name !== '.git')
              await repairMarkers(
                join(node.worktree_path, entry.name),
                join(target, entry.name),
                map,
                repo,
                node.worktree_path,
                caches,
              );
        }
      }
      if (source !== null && existsSync(map(source))) {
        for (const entry of await readdir(map(source), { withFileTypes: true }))
          if (entry.isDirectory() && entry.name !== '.git')
            await repairMarkers(
              join(source, entry.name),
              join(map(source), entry.name),
              map,
              repo,
              source,
              caches,
            );
      }
      if (caches.length > 0)
        await writeFile(join(repo, MODULE_CACHE_FILE), JSON.stringify(caches, null, 2));
      for (const node of store.listNodes(project.id)) {
        const tip = tipOf(node);
        if (tip === null) continue;
        for (const entry of (await git(['ls-tree', '-r', '-z', tip], repo)).split('\0')) {
          if (!entry.startsWith('160000 ')) continue;
          const [description, file] = entry.split('\t');
          const commit = description!.split(' ')[2]!;
          let available = false;
          for (const cache of caches.filter((cache) => cache.path === file))
            if (await commitExists(resolve(repo, cache.gitDir), commit)) {
              available = true;
              break;
            }
          if (!available)
            throw new OperationConflict(
              `Submodule code for ${node.display_name}/${file ?? ''} is not available locally. Open that experiment's folder to initialise its submodules, then retry the backup.`,
            );
        }
      }
      roots.set(project.id, projectRoots);
      await git(['fsck', '--full', '--no-dangling'], repo);
    }
    // Independent exports, preserved recovery folders and managed SDK sessions.
    for (const name of ['exports', 'recovery', 'sessions', 'patches']) {
      const source = join(dataDir, name);
      if (existsSync(source))
        await cp(source, join(path, name), {
          recursive: true,
          dereference: false,
          preserveTimestamps: true,
        });
    }
    const backupDb = openDatabase(path);
    try {
      const backup = new BackupStore(backupDb, join(path, 'repos'));
      for (const project of backup.listProjects()) {
        backup.remapProjectPaths(project.id, mapper(roots.get(project.id)!));
        backupDb
          .prepare('UPDATE project SET repo_path = ? WHERE id = ?')
          .run(join(path, 'repos', project.id, 'repo.git'), project.id);
        if (project.source_kind === 'adopted' && project.source_path !== null)
          backup.setMetadata(`backup_source:${project.id}`, 'true');
      }
      backup.setMetadata('data_root', path);
      const result = backupDb.prepare('PRAGMA integrity_check').get() as {
        integrity_check: string;
      };
      if (result.integrity_check !== 'ok')
        throw new Error('Backup database integrity check failed.');
      if (backupDb.prepare('PRAGMA foreign_key_check').all().length > 0)
        throw new Error('Backup database references are inconsistent.');
    } finally {
      backupDb.close();
    }
    await writeFile(join(path, 'settings.json'), settings.backupPreferences(join(path, 'repos')), {
      mode: 0o600,
    });
    for (const check of checks)
      if ((await fingerprint(check.path, check.git ? 'git' : 'working')) !== check.digest)
        throw new OperationConflict(
          'Project files or Git state changed outside Bonsai during backup. The copy is incomplete; retry when those writes finish.',
        );
    await writeFile(
      join(path, 'backup.json'),
      JSON.stringify(
        {
          complete: true,
          createdAt,
          conversationFallbacks,
          projects: store.listProjects().length,
          credentialsIncluded: false,
        },
        null,
        2,
      ) + '\n',
    );
    return { path, createdAt, conversationFallbacks };
  } catch (error) {
    throw new OperationConflict(
      `Backup could not finish. The incomplete copy is kept at ${path}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
