import { type JSX, type KeyboardEvent, useMemo, useRef, useState } from 'react';
import type { ChangedFile } from '@bonsai/shared';

import { Icon } from '../../Icon.tsx';
import { STATUS_LETTER, buildTree, visibleRows, type TreeRow } from './fileTree.ts';

/**
 * Changed files as a folder tree (an ARIA treeview).
 *
 * Folders collapse; files never expand -- a file opens in its own window, so
 * the list stays a list however many files there are. One row is tabbable at
 * a time and the arrow keys move between rows, the way a tree is operated
 * everywhere else.
 */
export function FileTree({
  files,
  label,
  openPaths,
  expandAll,
  onOpen,
}: {
  files: readonly ChangedFile[];
  label: string;
  /** Files already open in a window, marked as such. */
  openPaths: ReadonlySet<string>;
  /** While filtering, every folder is open: a match hidden in a collapsed folder is not found. */
  expandAll: boolean;
  onOpen: (file: ChangedFile) => void;
}): JSX.Element {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(
    () => visibleRows(tree, expandAll ? new Set() : collapsed),
    [tree, collapsed, expandAll],
  );
  const [active, setActive] = useState<string | null>(null);
  const activeIndex = Math.max(
    0,
    rows.findIndex((row) => row.entry.path === active),
  );
  const refs = useRef(new Map<number, HTMLDivElement>());

  const moveTo = (index: number): void => {
    const clamped = Math.min(Math.max(index, 0), rows.length - 1);
    const row = rows[clamped];
    if (row === undefined) return;
    setActive(row.entry.path);
    refs.current.get(clamped)?.focus();
  };
  const toggle = (path: string, open?: boolean): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      const shouldOpen = open ?? next.has(path);
      if (shouldOpen) next.delete(path);
      else next.add(path);
      return next;
    });
  const activate = (row: TreeRow): void => {
    if (row.entry.kind === 'file') onOpen(row.entry.file);
    else toggle(row.entry.path);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: TreeRow, index: number): void => {
    const folder = row.entry.kind === 'folder';
    const isOpen = folder && (expandAll || !collapsed.has(row.entry.path));
    const handled = (): void => event.preventDefault();
    switch (event.key) {
      case 'ArrowDown':
        handled();
        moveTo(index + 1);
        break;
      case 'ArrowUp':
        handled();
        moveTo(index - 1);
        break;
      case 'Home':
        handled();
        moveTo(0);
        break;
      case 'End':
        handled();
        moveTo(rows.length - 1);
        break;
      case 'ArrowRight':
        handled();
        if (folder && !isOpen) toggle(row.entry.path, true);
        else if (folder) moveTo(index + 1);
        break;
      case 'ArrowLeft': {
        handled();
        if (folder && isOpen && !expandAll) toggle(row.entry.path, false);
        else if (row.parent !== null) {
          moveTo(rows.findIndex((r) => r.entry.kind === 'folder' && r.entry.path === row.parent));
        }
        break;
      }
      case 'Enter':
      case ' ':
        handled();
        activate(row);
        break;
    }
  };

  return (
    <div className="file-tree" role="tree" aria-label={label}>
      {rows.map((row, index) => {
        const { entry } = row;
        const isOpen = entry.kind === 'folder' && (expandAll || !collapsed.has(entry.path));
        const counts =
          entry.kind === 'folder'
            ? { added: entry.added, removed: entry.removed, binary: false }
            : entry.file;
        return (
          <div
            key={`${entry.kind}:${entry.path}`}
            ref={(element) => {
              if (element === null) refs.current.delete(index);
              else refs.current.set(index, element);
            }}
            role="treeitem"
            aria-level={row.level}
            aria-expanded={entry.kind === 'folder' ? isOpen : undefined}
            aria-selected={index === activeIndex}
            tabIndex={index === activeIndex ? 0 : -1}
            className={`tree-row ${entry.kind}${entry.kind === 'file' && openPaths.has(entry.path) ? ' is-open' : ''}`}
            style={{ paddingInlineStart: `calc(${row.level - 1} * 1rem + var(--s2))` }}
            title={
              entry.kind === 'file'
                ? `${entry.path}${entry.file.oldPath === undefined ? '' : `\nRenamed from ${entry.file.oldPath}`}`
                : `${entry.path} · ${entry.files} file${entry.files === 1 ? '' : 's'}`
            }
            onClick={() => {
              setActive(entry.path);
              activate(row);
            }}
            onKeyDown={(event) => onKeyDown(event, row, index)}
          >
            {entry.kind === 'folder' ? (
              <span className={`tree-caret${isOpen ? ' open' : ''}`} aria-hidden="true">
                <Icon name="chevronRight" />
              </span>
            ) : (
              <span
                className={`st-letter st-${entry.file.status}`}
                aria-label={entry.file.status}
                title={entry.file.status}
              >
                {STATUS_LETTER[entry.file.status]}
              </span>
            )}
            <span
              className={`tree-name${entry.kind === 'file' && entry.file.status === 'deleted' ? ' deleted' : ''}`}
            >
              {entry.name}
            </span>
            {entry.kind === 'file' && entry.file.notes && (
              <span
                className="chip tiny"
                title="The agent’s notes about the work, not project code."
              >
                notes
              </span>
            )}
            {entry.kind === 'file' && entry.file.untracked === true && (
              <span className="chip tiny" title="A new file git is not tracking yet.">
                new
              </span>
            )}
            <span className="tree-counts">
              {counts.binary ? (
                <span className="muted">binary</span>
              ) : (
                <>
                  <span className="added">+{counts.added}</span>
                  <span className="removed">−{counts.removed}</span>
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
