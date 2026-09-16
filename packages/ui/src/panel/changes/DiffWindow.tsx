import { type JSX, memo, type PointerEvent, useRef } from 'react';

import { Icon } from '../../Icon.tsx';
import {
  MIN_HEIGHT,
  MIN_WIDTH,
  closeWindow,
  focusWindow,
  moveWindow,
  resizeWindow,
  showFile,
  toggleMaximized,
  toggleMinimized,
  windowId,
  type Area,
  type DiffWindow as Window,
  type Windows,
} from '../../state/windows.ts';
import { CopyButton, DiffBody } from './DiffBody.tsx';
import { STATUS_LETTER } from './fileTree.ts';
import { filesIn, useChangeSummary, useChangedFile } from './useChanges.ts';

type Change = (change: (state: Windows, area: Area) => Windows) => void;

const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type Edge = (typeof EDGES)[number];

/** Moves keyboard focus to a window, once it has been drawn. */
export function focusWindowElement(id: string): void {
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>(`[data-window-id="${CSS.escape(id)}"]`)?.focus(),
  );
}

/**
 * One file in a floating window (D44).
 *
 * Non-modal: the map, the panel and the other windows stay usable around it.
 * Dragged by its title bar, resized from any edge, brought forward by a click,
 * minimised to its title bar or maximised over the map. Previous, next and
 * Jump to file move through the same change without going back to the list.
 *
 * `full` is the narrow-window form: one file filling the screen, nothing to
 * drag, the same reading and navigation.
 */
export function DiffWindow({
  window,
  nodeId,
  revision,
  front,
  full = false,
  onChange,
}: {
  window: Window;
  nodeId: string;
  revision: string;
  front: boolean;
  full?: boolean;
  onChange: Change;
}): JSX.Element {
  const file = useChangedFile(nodeId, window.scope, window.path, revision);
  const summary = useChangeSummary(nodeId, window.scope, revision);
  const files = summary.data === null ? [] : filesIn(summary.data, window.scope);
  const index = files.findIndex((f) => f.path === window.path);
  const listed = files.find((f) => f.path === window.path) ?? file.data?.file ?? null;
  const titleId = `window-title-${window.opened}`;

  const go = (path: string): void => {
    onChange((state) => showFile(state, window.id, path));
    focusWindowElement(windowId(window.scope, path));
  };
  const close = (): void => onChange((state) => closeWindow(state, window.id));

  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const onTitlePointerDown = (event: PointerEvent<HTMLElement>): void => {
    if (full || window.maximized || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button, select, a, input')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, left: window.x, top: window.y };
  };
  const onTitlePointerMove = (event: PointerEvent<HTMLElement>): void => {
    const start = drag.current;
    if (start === null) return;
    onChange((state, area) =>
      moveWindow(
        state,
        window.id,
        start.left + event.clientX - start.x,
        start.top + event.clientY - start.y,
        area,
      ),
    );
  };

  const resize = useRef<{ edge: Edge; x: number; y: number; rect: Rect } | null>(null);
  const onEdgePointerDown = (edge: Edge) => (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resize.current = { edge, x: event.clientX, y: event.clientY, rect: { ...window } };
  };
  const onEdgePointerMove = (event: PointerEvent<HTMLElement>): void => {
    const start = resize.current;
    if (start === null) return;
    const rect = resized(start.rect, start.edge, event.clientX - start.x, event.clientY - start.y);
    onChange((state, area) => resizeWindow(state, window.id, rect, area));
  };

  const style = full
    ? undefined
    : window.maximized
      ? { zIndex: window.z }
      : {
          zIndex: window.z,
          left: window.x,
          top: window.y,
          width: window.minimized ? Math.min(window.width, 320) : window.width,
          height: window.minimized ? undefined : window.height,
        };

  const slash = window.path.lastIndexOf('/');
  const status = listed?.status ?? 'modified';

  return (
    <div
      className={`diff-window${front ? ' front' : ''}${window.minimized && !full ? ' minimized' : ''}${window.maximized && !full ? ' maximized' : ''}${full ? ' full' : ''}`}
      style={style}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-window-id={window.id}
      tabIndex={-1}
      onPointerDownCapture={() => onChange((state) => focusWindow(state, window.id))}
      onFocusCapture={() => onChange((state) => focusWindow(state, window.id))}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
          return;
        }
        const typing = (event.target as HTMLElement).closest('input, select, textarea');
        if (typing !== null || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === ']' && index !== -1 && index < files.length - 1) {
          event.preventDefault();
          go(files[index + 1]!.path);
        } else if (event.key === '[' && index > 0) {
          event.preventDefault();
          go(files[index - 1]!.path);
        }
      }}
    >
      <header
        className="win-title"
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={(event) => {
          if (full || (event.target as HTMLElement).closest('button')) return;
          onChange((state) => toggleMaximized(state, window.id));
        }}
      >
        <span className={`st-letter st-${status}`} title={status}>
          {STATUS_LETTER[status]}
        </span>
        <h2 id={titleId} className="win-path" title={window.path}>
          {slash !== -1 && <span className="win-dir">{window.path.slice(0, slash + 1)}</span>}
          <span className="win-base">{window.path.slice(slash + 1)}</span>
        </h2>
        {listed !== null && !listed.binary && (
          <span className="win-counts">
            <span className="added">+{listed.added}</span>
            <span className="removed">−{listed.removed}</span>
          </span>
        )}
        <span className="chip tiny win-scope">{window.scopeLabel}</span>
        <span className="win-controls">
          {!full && (
            <button
              aria-label={window.minimized ? 'Restore window' : 'Minimise window'}
              title={window.minimized ? 'Restore' : 'Minimise'}
              onClick={() => onChange((state) => toggleMinimized(state, window.id))}
            >
              <Icon name={window.minimized ? 'restore' : 'minus'} />
            </button>
          )}
          {!full && (
            <button
              aria-label={window.maximized ? 'Restore window size' : 'Maximise window'}
              title={window.maximized ? 'Restore size' : 'Maximise over the map'}
              onClick={() => onChange((state) => toggleMaximized(state, window.id))}
            >
              <Icon name={window.maximized ? 'restore' : 'maximize'} />
            </button>
          )}
          <button aria-label="Close window" title="Close (Esc)" onClick={close}>
            <Icon name="close" />
          </button>
        </span>
      </header>

      {(!window.minimized || full) && (
        <>
          <div className="win-tools">
            <button
              aria-label="Previous file"
              title="Previous file ([)"
              disabled={index <= 0}
              onClick={() => go(files[index - 1]!.path)}
            >
              <Icon name="chevronLeft" />
            </button>
            <button
              aria-label="Next file"
              title="Next file (])"
              disabled={index === -1 || index >= files.length - 1}
              onClick={() => go(files[index + 1]!.path)}
            >
              <Icon name="chevronRight" />
            </button>
            <select
              className="win-jump"
              aria-label="Jump to file"
              value={window.path}
              onChange={(event) => go(event.target.value)}
            >
              {index === -1 && <option value={window.path}>{window.path}</option>}
              {files.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                </option>
              ))}
            </select>
            {files.length > 0 && index !== -1 && (
              <span className="win-position" aria-hidden="true">
                {index + 1} of {files.length}
              </span>
            )}
            <CopyButton label="Copy path" text={window.path} />
            {file.data !== null && <CopyButton label="Copy patch" text={file.data.patch} />}
          </div>
          <div className="win-body">
            {file.data !== null ? (
              <Body
                key={window.path}
                file={file.data.file}
                patch={file.data.patch}
                truncated={file.data.truncated}
              />
            ) : file.error !== null ? (
              <p className="error" role="alert">
                {file.error} <button onClick={file.retry}>Retry</button>
              </p>
            ) : (
              <p role="status" className="diff-note">
                Loading {window.path}…
              </p>
            )}
          </div>
        </>
      )}

      {!full &&
        !window.minimized &&
        !window.maximized &&
        EDGES.map((edge) => (
          <span
            key={edge}
            className={`win-edge ${edge}`}
            aria-hidden="true"
            onPointerDown={onEdgePointerDown(edge)}
            onPointerMove={onEdgePointerMove}
            onPointerUp={() => (resize.current = null)}
            onPointerCancel={() => (resize.current = null)}
          />
        ))}
    </div>
  );
}

/** Dragging a window must not re-render a thousand diff lines per pointer move. */
const Body = memo(DiffBody);

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle dragged from one edge or corner, never below the minimum size. */
export function resized(rect: Rect, edge: Edge, dx: number, dy: number): Rect {
  let { x, y, width, height } = rect;
  if (edge.includes('e')) width = Math.max(MIN_WIDTH, rect.width + dx);
  if (edge.includes('s')) height = Math.max(MIN_HEIGHT, rect.height + dy);
  if (edge.includes('w')) {
    width = Math.max(MIN_WIDTH, rect.width - dx);
    x = rect.x + rect.width - width;
  }
  if (edge.includes('n')) {
    height = Math.max(MIN_HEIGHT, rect.height - dy);
    y = rect.y + rect.height - height;
  }
  return { x, y, width, height };
}
