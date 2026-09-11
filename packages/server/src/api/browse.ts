import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface DirectoryEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  home: string;
  entries: DirectoryEntry[];
}

/**
 * Lists folders so the UI can offer a picker.
 *
 * A browser cannot hand a server a filesystem path -- a file input gives names,
 * not locations -- so choosing a directory has to be done server-side. Bonsai
 * is bound to loopback and already runs an agent with file access, so reading
 * directory names adds no exposure it did not already have.
 *
 * Folders only, and hidden ones are skipped apart from the fact that a `.git`
 * child is what marks a repository.
 */
export async function listDirectory(path?: string): Promise<DirectoryListing> {
  const target = resolve(path === undefined || path.trim() === '' ? homedir() : path);
  const parent = dirname(target);

  let names: string[] = [];
  try {
    names = await readdir(target);
  } catch {
    // An unreadable directory lists as empty rather than failing the request;
    // the picker stays usable and the user can navigate back out.
    names = [];
  }

  const entries: DirectoryEntry[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = join(target, name);
    try {
      if (!(await stat(full)).isDirectory()) continue;
      entries.push({
        name,
        path: full,
        isGitRepo: await exists(join(full, '.git')),
      });
    } catch {
      // Broken symlinks and permission errors just do not appear.
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { path: target, parent: parent === target ? null : parent, home: homedir(), entries };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
