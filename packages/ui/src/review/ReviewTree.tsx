import { type JSX, useMemo, useRef } from 'react';
import type { ReviewFile } from '@bonsai/shared';

import { buildTree, fileAfter, rowsOf, type Row } from './fileTree.ts';
import { Icon } from '../Icon.tsx';
import { plural } from '../words.ts';

/**
 * The changed files, with the path to the open one drawn.
 *
 * Depth is guide rails rather than indentation: one 11px cell per ancestor,
 * each carrying a hairline, lit along the open file's ancestry. A folder gets
 * a caret, a file hangs off the branch on an elbow, and the git status letter
 * sits in its own column at the right. No per-file counts and no weight bars
 * — the totals are in the header, once.
 */
export function ReviewTree({
  files,
  totals,
  selectedPath,
  filter,
  collapsed,
  onFilter,
  onSelect,
  onToggle,
}: {
  files: readonly ReviewFile[];
  totals: { files: number; added: number; removed: number };
  selectedPath: string | null;
  filter: string;
  collapsed: ReadonlySet<string>;
  onFilter: (value: string) => void;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}): JSX.Element {
  const tree = useMemo(() => buildTree(files), [files]);
  const rows = useMemo(
    () => rowsOf(tree, { collapsed, selectedPath, filter }),
    [tree, collapsed, selectedPath, filter],
  );
  const filterRef = useRef<HTMLInputElement>(null);

  return (
    <div className="review-tree">
      <header>
        <div className="tree-totals">
          <span className="tree-count">{plural(totals.files, 'file')}</span>
          <span className="added">+{totals.added.toLocaleString()}</span>
          <span className="tree-removed">−{totals.removed.toLocaleString()}</span>
        </div>
        <div className="tree-filter">
          <input
            ref={filterRef}
            type="search"
            value={filter}
            placeholder="Filter files"
            aria-label="Filter files"
            onChange={(event) => onFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && filter !== '') {
                event.stopPropagation();
                onFilter('');
              }
            }}
          />
          <span className="keycap" aria-hidden="true">
            /
          </span>
        </div>
      </header>

      <div
        className="tree-rows"
        role="tree"
        aria-label="Changed files"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          const next = fileAfter(rows, selectedPath, event.key === 'ArrowDown' ? 1 : -1);
          if (next !== null) onSelect(next);
        }}
      >
        {rows.length === 0 && (
          <p className="tree-empty">
            {filter.trim() === '' ? 'No files changed.' : `Nothing matches “${filter.trim()}”.`}
          </p>
        )}
        {rows.map((row) => (
          <TreeRow
            key={`${row.node.kind}:${row.node.path}`}
            row={row}
            selected={row.node.kind === 'file' && row.node.path === selectedPath}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        ))}
      </div>
    </div>
  );
}

function TreeRow({
  row,
  selected,
  onSelect,
  onToggle,
}: {
  row: Row;
  selected: boolean;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}): JSX.Element {
  const { node } = row;
  const folder = node.kind === 'folder';
  return (
    <div
      className={`tree-row${selected ? ' selected' : ''}${folder ? ' folder' : ' file'}`}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      aria-expanded={folder ? row.expanded : undefined}
      tabIndex={selected ? 0 : -1}
      title={node.path}
      onClick={() => (folder ? onToggle(node.path) : onSelect(node.path))}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        if (folder) onToggle(node.path);
        else onSelect(node.path);
      }}
    >
      {selected && <span className="row-cap" aria-hidden="true" />}
      {Array.from({ length: row.depth }, (_, i) => (
        <span key={i} className={`guide${row.live ? ' live' : ''}`} aria-hidden="true" />
      ))}
      {folder ? (
        <span className={`caret${row.live ? ' live' : ''}`} aria-hidden="true">
          <Icon name={row.expanded === true ? 'chevronDown' : 'chevronRight'} />
        </span>
      ) : (
        <span className={`elbow${selected ? ' selected' : ''}`} aria-hidden="true" />
      )}
      <span className="tree-name">{node.name}</span>
      {node.kind === 'file' && (
        <span
          className={`git-letter st-${node.file.status}`}
          title={LETTER_TITLE[node.file.status]}
        >
          {node.file.status}
        </span>
      )}
    </div>
  );
}

const LETTER_TITLE = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  U: 'In the folder, not committed yet',
} as const;
