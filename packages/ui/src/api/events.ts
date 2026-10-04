import type { ServerEvent } from '@bonsai/shared';

/** A tab owns a port, never its own persistent HTTP connection. */
export function subscribe(
  projectId: string,
  onEvent: (event: ServerEvent) => void,
  onState?: (state: 'live' | 'reconnecting') => void,
): () => void {
  let dispose: (() => void) | null = null;
  let closed = false;

  // A finite request fallback also works with six or more unsupported-browser tabs.
  // A revision change reconciles persisted state; it never pretends to replay deltas.
  const poll = (): (() => void) => {
    let stopped = false;
    let revision: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const tick = async (): Promise<void> => {
      controller = new AbortController();
      try {
        const response = await fetch(
          `/api/events/check?projectId=${encodeURIComponent(projectId)}`,
          {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
          },
        );
        if (!response.ok) throw new Error('Live updates unavailable');
        const value = (await response.json()) as { revision: string };
        if (!stopped && value.revision !== revision) {
          revision = value.revision;
          onState?.('live');
        }
      } catch {
        if (!stopped) {
          revision = null;
          onState?.('reconnecting');
        }
      } finally {
        if (!stopped)
          timer = setTimeout(() => {
            void tick();
          }, 1500);
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    };
  };

  const connect = (): void => {
    dispose?.();
    dispose = null;
    if (closed || !navigator.onLine) {
      onState?.('reconnecting');
      return;
    }
    onState?.('reconnecting');
    if (typeof SharedWorker === 'undefined') {
      dispose = poll();
      return;
    }
    let worker: SharedWorker;
    try {
      worker = new SharedWorker(new URL('./events.worker.ts', import.meta.url), {
        type: 'module',
        name: 'bonsai-events',
      });
    } catch {
      dispose = poll();
      return;
    }
    let active = true;
    const close = (): void => {
      active = false;
      clearTimeout(timer);
      worker.onerror = null;
      worker.port.postMessage({ close: true });
      worker.port.close();
    };
    const fallback = (): void => {
      if (!active) return;
      close();
      dispose = poll();
    };
    const timer = setTimeout(fallback, 3000);
    worker.onerror = fallback;
    worker.port.onmessage = (
      message: MessageEvent<{
        ready?: boolean;
        state?: 'live' | 'reconnecting';
        event?: ServerEvent;
      }>,
    ) => {
      if (!active) return;
      if (message.data.ready) clearTimeout(timer);
      if (message.data.state) onState?.(message.data.state);
      if (message.data.event) onEvent(message.data.event);
    };
    worker.port.postMessage({ projectId });
    worker.port.start();
    dispose = close;
  };
  const pause = (): void => {
    dispose?.();
    dispose = null;
  };
  const offline = (): void => {
    pause();
    onState?.('reconnecting');
  };
  const resume = (event: PageTransitionEvent): void => {
    if (event.persisted) connect();
  };
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', resume);
  window.addEventListener('offline', offline);
  window.addEventListener('online', connect);
  connect();
  return () => {
    closed = true;
    pause();
    window.removeEventListener('pagehide', pause);
    window.removeEventListener('pageshow', resume);
    window.removeEventListener('offline', offline);
    window.removeEventListener('online', connect);
  };
}
