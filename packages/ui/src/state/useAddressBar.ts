import { useCallback, useEffect, useRef } from 'react';

/**
 * The open project and the selected node, in the URL.
 *
 * Without this a reload loses your place, a node cannot be bookmarked or
 * linked to, and two windows cannot show two projects. All three are the same
 * missing thing: the app's location was only ever in memory.
 *
 * Query parameters through the History API, and no routing dependency. There
 * are two values; a router would be several hundred kilobytes to hold them.
 *
 * `replaceState`, not `pushState`. Selecting nodes is something you do dozens
 * of times while reading a tree, and each one becoming a back-button step
 * would bury whatever page you were on before Bonsai under fifty entries.
 * Nothing here is a navigation in the sense the back button means.
 */

export interface Address {
  projectId: string | null;
  nodeId: string | null;
}

export function readAddress(): Address {
  const params = new URLSearchParams(window.location.search);
  return {
    projectId: params.get('project'),
    nodeId: params.get('node'),
  };
}

/**
 * Keeps the URL in step with what is open, and reports what it said on load.
 *
 * The initial value is captured once, in a ref, before anything can overwrite
 * it: the app's own startup writes to the address bar within a tick or two, so
 * reading it later would return whatever the app had just put there rather
 * than what the user arrived with.
 */
export function useAddressBar(current: Address): { initial: Address; clear: () => void } {
  const initial = useRef<Address | null>(null);
  initial.current ??= readAddress();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (current.projectId === null) params.delete('project');
    else params.set('project', current.projectId);
    if (current.nodeId === null) params.delete('node');
    else params.set('node', current.nodeId);

    const query = params.toString();
    const next = `${window.location.pathname}${query === '' ? '' : `?${query}`}`;
    // Guarded because this effect runs on every render that changes either
    // value, and rewriting the same URL is a needless history entry's worth of
    // work even with replaceState.
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, '', next);
    }
  }, [current.projectId, current.nodeId]);

  return {
    initial: initial.current,
    clear: useCallback(() => {
      window.history.replaceState(null, '', window.location.pathname);
    }, []),
  };
}
