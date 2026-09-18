import type { ReviewFile } from '@bonsai/shared';

/**
 * The changed files, as the tree review draws.
 *
 * Depth is DRAWN, not padded: every row carries one guide cell per ancestor,
 * and the guides on the open file's ancestors are lit. That is what makes the
 * path from the root to what you are reading visible without expanding
 * anything, and it is why this model hands out a depth and an "on the live
 * path" flag per row rather than an indent in pixels.
 *
 * Pure, so the rules can be tested without a browser.
 */
export interface TreeFolder {
  kind: 'folder';
  name: string;
  /** The folder's full path: what expansion and the live path are keyed by. */
  path: string;
  children: TreeNode[];
}

export interface TreeFile {
  kind: 'file';
  name: string;
  path: string;
  file: ReviewFile;
}

export type TreeNode = TreeFolder | TreeFile;

export interface Row {
  node: TreeNode;
  /** How many ancestors this row has: one guide cell each. */
  depth: number;
  /** True for the open file and every folder above it. */
  live: boolean;
  /** Folders only. */
  expanded?: boolean;
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function buildTree(files: readonly ReviewFile[]): TreeNode[] {
  const root: TreeFolder = { kind: 'folder', name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let at = root;
    for (const part of parts.slice(0, -1)) {
      const path = at.path === '' ? part : `${at.path}/${part}`;
      let next = at.children.find((c): c is TreeFolder => c.kind === 'folder' && c.path === path);
      if (next === undefined) {
        next = { kind: 'folder', name: part, path, children: [] };
        at.children.push(next);
      }
      at = next;
    }
    at.children.push({ kind: 'file', name: parts.at(-1) ?? file.path, path: file.path, file });
  }
  sort(root);
  return root.children;
}

/** Folders first, then files, each in the order a person counts in. */
function sort(folder: TreeFolder): void {
  folder.children.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : byName.compare(a.name, b.name),
  );
  for (const child of folder.children) if (child.kind === 'folder') sort(child);
}

/** Every folder on the way to a file: the ancestors that are always open. */
export function ancestorsOf(path: string | null): Set<string> {
  const out = new Set<string>();
  if (path === null) return out;
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i += 1) out.add(parts.slice(0, i).join('/'));
  return out;
}

/**
 * The rows on screen, top to bottom.
 *
 * Filtering opens everything: a match hidden inside a collapsed folder has not
 * been found. The selected file's ancestors are open whatever the user
 * collapsed, because the tree must always show where the open file is.
 */
export function rowsOf(
  tree: readonly TreeNode[],
  options: {
    collapsed: ReadonlySet<string>;
    selectedPath: string | null;
    filter?: string;
  },
): Row[] {
  const filter = (options.filter ?? '').trim().toLowerCase();
  const live = ancestorsOf(options.selectedPath);
  const rows: Row[] = [];

  const walk = (nodes: readonly TreeNode[], depth: number): boolean => {
    let kept = false;
    for (const node of nodes) {
      if (node.kind === 'file') {
        if (filter !== '' && !node.path.toLowerCase().includes(filter)) continue;
        rows.push({ node, depth, live: node.path === options.selectedPath });
        kept = true;
        continue;
      }
      const open = filter !== '' || live.has(node.path) || !options.collapsed.has(node.path);
      const at = rows.length;
      rows.push({ node, depth, live: live.has(node.path), expanded: open });
      const inside = open ? walk(node.children, depth + 1) : hasMatch(node, filter);
      if (filter !== '' && !inside) rows.splice(at, rows.length - at);
      else kept = true;
    }
    return kept;
  };
  walk(tree, 0);
  return rows;
}

function hasMatch(node: TreeNode, filter: string): boolean {
  if (filter === '') return true;
  if (node.kind === 'file') return node.path.toLowerCase().includes(filter);
  return node.children.some((child) => hasMatch(child, filter));
}

/** The file after (or before) the open one, for the second pane and the arrow keys. */
export function fileAfter(rows: readonly Row[], path: string | null, step: 1 | -1): string | null {
  const files = rows.flatMap((row) => (row.node.kind === 'file' ? [row.node.path] : []));
  if (files.length === 0) return null;
  const index = path === null ? -1 : files.indexOf(path);
  if (index === -1) return files[step === 1 ? 0 : files.length - 1] ?? null;
  return files[index + step] ?? null;
}
