import { type JSX, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { NodeView } from '@bonsai/shared';

import { Icon } from '../../Icon.tsx';
import { setWindowArea, useWindows, windowsKey } from '../../state/useWindows.ts';
import {
  closeAll,
  cycleWindows,
  frontWindow,
  stackWindows,
  tileWindows,
} from '../../state/windows.ts';
import { DiffWindow, focusWindowElement } from './DiffWindow.tsx';
import { useChangeRevision } from './useChanges.ts';

/**
 * Where the selected experiment's diff windows are drawn (D44): over the map,
 * never over the experiment panel, and never outside the app.
 *
 * Only the selected experiment's windows. Selecting another hides these and
 * shows its own; coming back finds them as they were.
 *
 * On a narrow window there is no room to float anything, so the front window
 * fills the screen instead, with the same reading and navigation, until it is
 * closed.
 */
export function WindowLayer({
  projectId,
  node,
  narrow,
}: {
  projectId: string | null;
  node: NodeView | null;
  narrow: boolean;
}): JSX.Element {
  const key = projectId !== null && node !== null ? windowsKey(projectId, node.id) : null;
  const { windows, change } = useWindows(key);
  const revision = useChangeRevision(node);
  // A callback ref, because the measured element is a different one in each
  // of the three layouts below: it is observed whenever one is attached.
  const observer = useRef<ResizeObserver | null>(null);
  const area = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (element === null) return;
    const measure = (): void =>
      setWindowArea({ width: element.clientWidth, height: element.clientHeight });
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(element);
  }, []);

  const count = windows.list.length;
  useEffect(() => {
    if (count === 0) return;
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      if (event.code !== 'BracketRight' && event.code !== 'BracketLeft') return;
      event.preventDefault();
      let front: string | null = null;
      change((state) => {
        const next = cycleWindows(state, event.code === 'BracketRight' ? 1 : -1);
        front = frontWindow(next)?.id ?? null;
        return next;
      });
      if (front !== null) focusWindowElement(front);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [count, change]);

  const front = frontWindow(windows);

  if (key === null || node === null) {
    return (
      <div className="window-layer">
        <div className="window-area" ref={area} />
      </div>
    );
  }

  if (narrow) {
    const shown = [...windows.list].sort((a, b) => b.z - a.z).find((w) => !w.minimized) ?? front;
    return (
      <div className="window-layer">
        <div className="window-area" ref={area} />
        {shown !== null &&
          createPortal(
            <div className="diff-viewer-full">
              <DiffWindow
                key={shown.id}
                window={shown}
                nodeId={node.id}
                revision={revision}
                front
                full
                onChange={change}
              />
            </div>,
            document.body,
          )}
      </div>
    );
  }

  return (
    <div className="window-layer">
      {count > 0 && (
        <div className="window-bar" role="toolbar" aria-label="Open files">
          <span className="window-count">
            {count} file{count === 1 ? '' : 's'} open
          </span>
          <button
            disabled={count < 2}
            title="Every window side by side, in equal shares of the map"
            onClick={() => change((state, size) => tileWindows(state, size))}
          >
            <Icon name="tile" /> Tile side by side
          </button>
          <button
            disabled={count < 2}
            title="Cascade the windows again"
            onClick={() => change((state, size) => stackWindows(state, size))}
          >
            <Icon name="stack" /> Stack
          </button>
          <button onClick={() => change((state) => closeAll(state))}>
            <Icon name="close" /> Close all
          </button>
        </div>
      )}
      <div className="window-area" ref={area}>
        {windows.list.map((w) => (
          <DiffWindow
            key={w.id}
            window={w}
            nodeId={node.id}
            revision={revision}
            front={w.id === front?.id}
            onChange={change}
          />
        ))}
      </div>
    </div>
  );
}
