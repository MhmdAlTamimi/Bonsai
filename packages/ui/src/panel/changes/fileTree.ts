import type { ChangedFile } from '@bonsai/shared';

/**
 * Changed files as a folder tree, the way an editor's source control view
 * shows them.
 *
 * A flat list of paths was the old view's other problem after the auto-opened
 * diffs: forty files under `src/components/...` read as forty unrelated lines.
 * Here a folder carries its files' counts, a chain of single folders collapses
 * into one row (`src/components/forms`), and nothing ever expands a patch --
 * a file opens in its own window.
 *
 * Pure, so the rules can be tested without a browser.
 */
export interface FolderEntry {
  kind: 'folder';
  /** What the row says: one folder, or a chain of them joined with '/'. */
  name: string;
  /** The folder's full path, which identifies it for collapsing. */
  path: string;
  children: TreeEntry[];
  files: number;
  added: number;
  removed: number;
}

export interface FileEntry {
  kind: 'file';
  name: string;
  path: string;
  file: ChangedFile;
}

export type TreeEntry = FolderEntry | FileEntry;

export interface TreeRow {
  entry: TreeEntry;
  /** 1 for the top level, as aria-level counts. */
  level: number;
  /** The folder this row sits in, or null at the top. */
  parent: string | null;
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function buildTree(files: readonly ChangedFile[]): TreeEntry[] {
  const root: FolderEntry = folder('', '');
  for (const file of files) {
    const parts = file.path.split('/');
    let at = root;
    for (const part of parts.slice(0, -1)) {
      const path = at.path === '' ? part : `${at.path}/${part}`;
      let next = at.children.find((c): c is FolderEntry => c.kind === 'folder' && c.path === path);
      if (next === undefined) {
        next = folder(part, path);
        at.children.push(next);
      }
      at = next;
    }
    at.children.push({ kind: 'file', name: parts.at(-1) ?? file.path, path: file.path, file });
  }
  return finish(root).children;
}

/** Folders first, then files, each in natural order; counts summed; single-folder chains merged. */
function finish(entry: FolderEntry): FolderEntry {
  let current = entry;
  current.children = current.children.map((child) =>
    child.kind === 'folder' ? finish(child) : child,
  );
  // A folder whose only content is one folder says nothing on its own row.
  for (
    let only = soleFolder(current);
    current.path !== '' && only !== null;
    only = soleFolder(current)
  ) {
    current = { ...only, name: `${current.name}/${only.name}` };
  }
  current.children.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : byName.compare(a.name, b.name),
  );
  current.files = 0;
  current.added = 0;
  current.removed = 0;
  for (const child of current.children) {
    if (child.kind === 'folder') {
      current.files += child.files;
      current.added += child.added;
      current.removed += child.removed;
    } else {
      current.files += 1;
      current.added += child.file.added;
      current.removed += child.file.removed;
    }
  }
  return current;
}

function soleFolder(entry: FolderEntry): FolderEntry | null {
  const [only, ...rest] = entry.children;
  return rest.length === 0 && only?.kind === 'folder' ? only : null;
}

function folder(name: string, path: string): FolderEntry {
  return { kind: 'folder', name, path, children: [], files: 0, added: 0, removed: 0 };
}

/** Rows on screen, top to bottom: what the tree renders and the arrow keys walk. */
export function visibleRows(tree: readonly TreeEntry[], collapsed: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (entries: readonly TreeEntry[], level: number, parent: string | null): void => {
    for (const entry of entries) {
      rows.push({ entry, level, parent });
      if (entry.kind === 'folder' && !collapsed.has(entry.path)) {
        walk(entry.children, level + 1, entry.path);
      }
    }
  };
  walk(tree, 1, null);
  return rows;
}

/**
 * Files whose path contains every word typed, in any case. Matched against
 * where a renamed file came from as well, since that is the name someone may
 * remember.
 */
export function filterFiles(files: readonly ChangedFile[], query: string): ChangedFile[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...files];
  return files.filter((file) => {
    const haystack = `${file.path} ${file.oldPath ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** Above this many files the list gets a filter box. */
export const FILTER_FROM = 15;

/** The one letter source control views use for each status. */
export const STATUS_LETTER: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};
