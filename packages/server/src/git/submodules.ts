import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { git, gitLine } from './exec.js';
import { commitExists } from './repo.js';
import { isInside } from '../paths.js';
import { OperationConflict } from '../domain/errors.js';

export const MODULE_CACHE_FILE = 'bonsai-submodules.json';
export interface ModuleCache {
  path: string;
  gitDir: string;
}

export async function gitlinks(path: string): Promise<Array<{ path: string; commit: string }>> {
  const links = new Map<string, string>();
  for (const entry of (await git(['ls-files', '--stage', '-z'], path)).split('\0')) {
    if (!entry.startsWith('160000 ')) continue;
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const file = entry.slice(tab + 1);
    if (!isInside(path, join(path, file))) throw new OperationConflict('Invalid submodule path.');
    links.set(file, entry.slice(7, entry.indexOf(' ', 7)));
  }
  return [...links].map(([path, commit]) => ({ path, commit }));
}

/** Backup-local caches stay valid when the data folder moves; only relative paths are recorded. */
export async function initialiseSubmodules(path: string): Promise<void> {
  if (!existsSync(join(path, '.gitmodules'))) return;
  try {
    const common = await gitLine(['rev-parse', '--path-format=absolute', '--git-common-dir'], path);
    const file = join(common, MODULE_CACHE_FILE);
    if (!existsSync(file)) {
      await git(['submodule', 'update', '--init', '--recursive'], path);
      return;
    }
    const caches = JSON.parse(await readFile(file, 'utf8')) as ModuleCache[];
    const initialise = async (folder: string, prefix: string): Promise<void> => {
      if (!existsSync(join(folder, '.gitmodules'))) return;
      const names = new Map<string, string>();
      const config = await git(
        ['config', '--file', '.gitmodules', '--null', '--get-regexp', '^submodule[.].*[.]path$'],
        folder,
      );
      for (const entry of config.split('\0')) {
        const newline = entry.indexOf('\n');
        if (newline < 0) continue;
        names.set(
          entry.slice(newline + 1),
          entry.slice('submodule.'.length, newline - '.path'.length),
        );
      }
      for (const link of await gitlinks(folder)) {
        const key = prefix ? `${prefix}/${link.path}` : link.path;
        let cached: string | null = null;
        for (const entry of caches.filter((candidate) => candidate.path === key)) {
          const candidate = resolve(common, entry.gitDir);
          if (!isInside(common, candidate))
            throw new OperationConflict('Invalid backup submodule cache.');
          if (existsSync(candidate) && (await commitExists(candidate, link.commit))) {
            cached = candidate;
            break;
          }
        }
        const name = names.get(link.path);
        await git(
          [
            ...(cached !== null && name !== undefined
              ? ['-c', 'protocol.file.allow=always', '-c', `submodule.${name}.url=${cached}`]
              : []),
            'submodule',
            'update',
            '--init',
            '--',
            link.path,
          ],
          folder,
        );
        await initialise(join(folder, link.path), key);
      }
    };
    await initialise(path, '');
  } catch (error) {
    throw new Error(
      `Could not initialise this experiment’s submodules. Check their repository access and try again. ${String(error)}`,
    );
  }
}

/** Moving a checkout must repair its nested Git pointers as well as the top-level worktree. */
export async function relocateSubmodules(
  path: string,
  map: (path: string) => string,
  oldCommon: string,
  common: string,
): Promise<void> {
  for (const link of await gitlinks(path)) {
    const folder = join(path, link.path);
    const marker = join(folder, '.git');
    if (!existsSync(marker)) continue;
    const text = await readFile(marker, 'utf8');
    if (!text.startsWith('gitdir: '))
      throw new OperationConflict('A submodule is not a recorded linked checkout.');
    const original = resolve(folder, text.slice(8).trim());
    if (![oldCommon, common].some((root) => isInside(root, original)))
      throw new OperationConflict(
        'The submodule uses a different repository. Its files were preserved.',
      );
    const admin = map(original);
    if (!isInside(common, admin) || !existsSync(admin))
      throw new OperationConflict('The submodule Git data is missing. Restore a complete backup.');
    await writeFile(marker, `gitdir: ${admin}\n`);
    await git(['config', '--file', join(admin, 'config'), 'core.worktree', folder], common);
    await relocateSubmodules(folder, map, oldCommon, common);
  }
}
