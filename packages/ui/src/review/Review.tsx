import { type JSX, useEffect, useMemo, useRef, useState } from 'react';
import type { NodeView, ReviewFile } from '@bonsai/shared';

import { BackToMap } from '../BackToMap.tsx';
import { ErrorNote } from '../ErrorNote.tsx';
import { Icon, IconButton } from '../Icon.tsx';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import { STATUS_LABEL, nodeStatusTitle } from '../nodeStatus.tsx';
import { DiffPane } from './DiffPane.tsx';
import { Grip } from './Grip.tsx';
import { ReviewTree } from './ReviewTree.tsx';
import { buildTree, fileAfter, rowsOf } from './fileTree.ts';
import { ReviewMenu } from './ReviewMenu.tsx';
import { ApplyDialog } from '../panel/node/ApplyDialog.tsx';
import { useFilePatch, useReview } from './useReview.ts';

/** The tree never goes below this, or the paths stop being readable. */
const MIN_TREE = 200;
const MAX_TREE = 460;

/**
 * Reviewing one experiment's changes (D46).
 *
 * A full-screen replacement for the map rather than an overlay: reading a
 * change is the whole job while you are doing it, and the conversation stays
 * docked beside it because the question a diff raises is asked there.
 *
 * The file tree is the index, one or two diff panes are the reading, and
 * nothing here opens a browser tab or a window outside the app.
 */
export function Review({
  node,
  revision,
  onBack,
}: {
  node: NodeView | null;
  /** Changes when the experiment does, so the list and the open patch refetch. */
  revision: string;
  onBack: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<'diff' | 'file'>('diff');
  const [wrap, setWrap] = useState(false);
  const [savingWrap, setSavingWrap] = useState(false);
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    void api
      .settings()
      .then((s) => setWrap(s.wrapLines))
      .catch((e) => setError(describeError(e)));
  }, []);
  const review = useReview(node?.id ?? null, revision);
  const [selected, setSelected] = useState<[string | null, string | null]>([null, null]);
  const [focusedPane, setFocusedPane] = useState<0 | 1>(0);
  const [split, setSplit] = useState(false);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [treeWidth, setTreeWidth] = useState(272);
  const [paneSplit, setPaneSplit] = useState(0.5);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // A different experiment is a different change: nothing carries over.
  useEffect(() => {
    setSelected([null, null]);
    setSplit(false);
    setFilter('');
    setCollapsed(new Set());
  }, [node?.id]);

  // Its own memo: a fresh [] every render would rebuild the tree every render.
  const files = useMemo(() => review.data?.files ?? [], [review.data]);
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const rows = useMemo(
    () => rowsOf(buildTree(files), { collapsed, selectedPath: selected[focusedPane], filter }),
    [files, collapsed, selected, focusedPane, filter],
  );

  // The first file opens itself: a review screen with nothing in it wastes the
  // click that got here. The first in the TREE, which is what the reader sees
  // at the top, rather than the first alphabetically.
  useEffect(() => {
    if (selected[0] !== null || files.length === 0) return;
    const first = fileAfter(rows, null, 1);
    if (first !== null) setSelected([first, null]);
  }, [files, selected, rows]);

  const open = (path: string, pane: 0 | 1 = focusedPane): void => {
    setSelected((prev) => (pane === 0 ? [path, prev[1]] : [prev[0], path]));
    setFocusedPane(pane);
  };

  const toggleSplit = (): void => {
    if (split) {
      setSplit(false);
      setFocusedPane(0);
      return;
    }
    // Opening the split shows another file, so it is a comparison rather than
    // the same file twice: the next one along, or the one before when the open
    // file is the last.
    setSelected((prev) => [
      prev[0],
      prev[1] ?? fileAfter(rows, prev[0], 1) ?? fileAfter(rows, prev[0], -1) ?? prev[0],
    ]);
    setSplit(true);
  };

  /**
   * Esc leaves, `/` reaches the filter — from anywhere on the screen, so they
   * work without first clicking into the tree. Listening on the window rather
   * than on this element, which only sees keys when focus is already inside
   * it. Never while typing: both are characters someone may be writing.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const typing = (event.target as HTMLElement | null)?.closest('input, textarea, select');
      if (typing !== null) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onBack();
      }
      if (event.key === '/') {
        event.preventDefault();
        root.current?.querySelector<HTMLInputElement>('.tree-filter input')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const first = useFilePatch(node?.id ?? null, selected[0], revision, mode);
  const second = useFilePatch(node?.id ?? null, split ? selected[1] : null, revision, mode);
  const openFile = (path: string | null): ReviewFile | null =>
    path === null ? null : (byPath.get(path) ?? null);

  return (
    <div className={`review${wrap ? ' wrap-lines' : ''}`} ref={root}>
      <header className="review-bar">
        <BackToMap onBack={onBack} />
        <span className="bar-divider" aria-hidden="true" />
        <h1 title={node?.displayName}>{node?.displayName ?? 'No experiment'}</h1>
        {node !== null && (
          <span className="review-status" title={nodeStatusTitle(node)}>
            <span className={`status-dot st-${node.status}`} aria-hidden="true" />
            {STATUS_LABEL[node.status]}
          </span>
        )}
        <div className="spacer" />
        <div className="review-tools" role="group" aria-label="File viewing controls">
          <div className="segmented-control" role="group" aria-label="View mode">
            <button
              title="Show changes (Diff)"
              aria-label="Diff"
              aria-pressed={mode === 'diff'}
              onClick={() => setMode('diff')}
            >
              <Icon name="diff" />
            </button>
            <button
              title="Show full file"
              aria-label="File"
              aria-pressed={mode === 'file'}
              onClick={() => setMode('file')}
            >
              <Icon name="file" />
            </button>
          </div>
          <button
            className="toolbar-icon"
            title="Wrap lines"
            aria-label="Wrap lines"
            aria-pressed={wrap}
            disabled={savingWrap}
            onClick={async () => {
              setSavingWrap(true);
              try {
                const settings = await api.updateSettings({ wrapLines: !wrap });
                setWrap(settings.wrapLines);
              } catch (e) {
                setError(describeError(e));
              } finally {
                setSavingWrap(false);
              }
            }}
          >
            <Icon name="wrap" />
          </button>
          <IconButton
            icon="folderOpen"
            className="toolbar-icon"
            label={
              node?.folder === 'archived'
                ? 'Open experiment folder (brings it back from the archive)'
                : 'Open experiment folder'
            }
            disabled={!node}
            onClick={() => {
              if (node) void api.revealNode(node.id).catch((e) => setError(describeError(e)));
            }}
          />
          <IconButton
            icon="apply"
            className="toolbar-icon apply-button"
            label="Apply to your repo"
            disabled={node?.diffStat == null}
            onClick={() => setApplying(true)}
          />
        </div>
        {split ? (
          <ViewToggle split onChange={toggleSplit} />
        ) : (
          <>
            <FileIdentity file={openFile(selected[0])} />
            {files.length > 1 && <ViewToggle split={false} onChange={toggleSplit} />}
          </>
        )}
        {node !== null && <ReviewMenu node={node} revision={revision} />}
      </header>
      {applying && node !== null && (
        <ApplyDialog node={node} onClose={() => setApplying(false)} returnFocus=".apply-button" />
      )}
      {error !== null && (
        <ErrorNote className="review-error" onDismiss={() => setError(null)}>
          {error}
        </ErrorNote>
      )}

      <div className="review-body">
        <div className="tree-column" style={{ width: `${treeWidth}px` }}>
          {review.error !== null && review.data === null ? (
            <ErrorNote onRetry={review.retry}>{review.error}</ErrorNote>
          ) : review.data === null ? (
            <p className="tree-empty loading" role="status">
              Loading changes
            </p>
          ) : (
            <ReviewTree
              files={files}
              totals={review.data.totals}
              selectedPath={selected[focusedPane]}
              filter={filter}
              collapsed={collapsed}
              onFilter={setFilter}
              onSelect={(path) => open(path)}
              onToggle={(path) =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                })
              }
            />
          )}
        </div>

        <Grip
          label="Resize the file list"
          onDrag={(delta) =>
            setTreeWidth((width) => Math.min(MAX_TREE, Math.max(MIN_TREE, width + delta)))
          }
        />

        <DiffPane
          file={openFile(selected[0])}
          patch={first.data?.patch ?? null}
          content={first.data?.content}
          contentRevision={first.data?.contentRevision}
          error={first.error}
          truncated={first.data?.truncated}
          focused={split && focusedPane === 0}
          onFocus={() => setFocusedPane(0)}
          empty={review.data !== null && files.length === 0}
          header={
            split ? (
              <PaneHeader file={openFile(selected[0])} />
            ) : review.data !== null && files.length === 0 ? (
              <p className="diff-note">This experiment has not changed any files.</p>
            ) : undefined
          }
        />

        {split && (
          <>
            <Grip
              label="Resize the panes"
              onDrag={(delta) =>
                setPaneSplit((value) => Math.min(0.8, Math.max(0.2, value + delta / 900)))
              }
            />
            <div className="second-pane" style={{ flex: `${(1 - paneSplit) / paneSplit}` }}>
              <DiffPane
                file={openFile(selected[1])}
                patch={second.data?.patch ?? null}
                content={second.data?.content}
                contentRevision={second.data?.contentRevision}
                error={second.error}
                truncated={second.data?.truncated}
                focused={focusedPane === 1}
                onFocus={() => setFocusedPane(1)}
                header={<PaneHeader file={openFile(selected[1])} />}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** `chunks/` then `chunk_002.md`: one path, two weights, no gap between them. */
function FileIdentity({ file }: { file: ReviewFile | null }): JSX.Element | null {
  if (file === null) return null;
  const cut = file.path.lastIndexOf('/');
  return (
    <span className="file-identity" title={file.path}>
      {cut !== -1 && <span className="path-dir">{file.path.slice(0, cut + 1)}</span>}
      <span className="path-name">{file.path.slice(cut + 1)}</span>
      {!file.binary && <span className="added">+{file.additions}</span>}
    </span>
  );
}

function PaneHeader({ file }: { file: ReviewFile | null }): JSX.Element {
  if (file === null) return <div className="pane-header" />;
  const cut = file.path.lastIndexOf('/');
  return (
    <div className="pane-header">
      {cut !== -1 && <span className="path-dir">{file.path.slice(0, cut + 1)}</span>}
      <span className="path-name">{file.path.slice(cut + 1)}</span>
      {!file.binary && <span className="added">+{file.additions}</span>}
      {!file.binary && file.deletions > 0 && <span className="removed">−{file.deletions}</span>}
    </div>
  );
}

/** One file, or two side by side. Drawn as bars, because that is what it does. */
function ViewToggle({ split, onChange }: { split: boolean; onChange: () => void }): JSX.Element {
  return (
    <div className="view-toggle" role="group" aria-label="How many files to show">
      <button
        aria-pressed={!split}
        title="One file"
        onClick={() => {
          if (split) onChange();
        }}
      >
        <span className="bar single" aria-hidden="true" />
        <span className="visually-hidden">One file</span>
      </button>
      <button
        aria-pressed={split}
        title="Two files side by side"
        onClick={() => {
          if (!split) onChange();
        }}
      >
        <span className="bar half" aria-hidden="true" />
        <span className="bar half" aria-hidden="true" />
        <span className="visually-hidden">Two files side by side</span>
      </button>
    </div>
  );
}
