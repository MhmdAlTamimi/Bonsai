import type { ServerEvent } from '@bonsai/shared';

// One worker/stream per browser origin, including tabs viewing different projects.
const ports = new Map<MessagePort, string>();
let source: EventSource | null = null;
let state: 'live' | 'reconnecting' = 'reconnecting';
const broadcastState = (): void => {
  for (const port of ports.keys()) port.postMessage({ state });
};
function connect(): void {
  if (source) return;
  source = new EventSource('/api/events?all=1');
  source.onopen = () => {
    state = 'live';
    broadcastState();
  };
  source.onerror = () => {
    state = 'reconnecting';
    broadcastState();
  };
  source.addEventListener('event', (message) => {
    const envelope = JSON.parse((message as MessageEvent<string>).data) as {
      projectId: string;
      event: ServerEvent;
    };
    for (const [port, projectId] of ports)
      if (projectId === '*' || projectId === envelope.projectId)
        port.postMessage({ event: envelope.event });
  });
}
function close(port: MessagePort): void {
  ports.delete(port);
  port.close();
  if (ports.size === 0) {
    source?.close();
    source = null;
    state = 'reconnecting';
  }
}
// The UI TypeScript project uses DOM types; keep this worker's small boundary explicit.
const worker = self as unknown as { onconnect: (event: MessageEvent) => void };
worker.onconnect = (event) => {
  const port = event.ports[0]!;
  port.onmessage = (message: MessageEvent<{ projectId?: string; close?: boolean }>) => {
    if (message.data.close) {
      close(port);
      return;
    }
    if (typeof message.data.projectId !== 'string') return;
    ports.set(port, message.data.projectId);
    port.postMessage({ ready: true, state });
    connect();
  };
  port.onmessageerror = () => close(port);
  port.start();
};
