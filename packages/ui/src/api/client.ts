import type {
  MessageView,
  NodeDetail,
  NodeView,
  ServerEvent,
  TreeResponse,
  UpdateNodeRequest,
} from '@bonsai/shared';

/**
 * The only module in the UI that knows a server exists.
 *
 * PRD §9 constraint 5: nothing touching git, the filesystem or the agent lives
 * in UI code. Everything below is HTTP against the one API surface.
 */

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body: unknown = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    const err = body as { error?: string; milestone?: string };
    throw new ApiCallError(err.error ?? res.statusText, res.status, err.milestone);
  }
  return body as T;
}

export class ApiCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly milestone?: string,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

export const api = {
  listProjects: () => json<Array<{ id: string; name: string }>>('/api/projects'),

  tree: (projectId: string) => json<TreeResponse>(`/api/projects/${projectId}/tree`),

  node: (nodeId: string) => json<NodeDetail>(`/api/nodes/${nodeId}`),

  messages: (nodeId: string, afterSeq = 0) =>
    json<MessageView[]>(`/api/nodes/${nodeId}/messages?afterSeq=${afterSeq}`),

  createNode: (
    projectId: string,
    body: { parentId: string; displayName: string; description: string },
  ) =>
    json<{ node: NodeView }>(`/api/projects/${projectId}/nodes`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateNode: (nodeId: string, body: UpdateNodeRequest) =>
    json<NodeView>(`/api/nodes/${nodeId}`, { method: 'PATCH', body: JSON.stringify(body) }),

  deleteNode: (nodeId: string) =>
    json<{ ok: true }>(`/api/nodes/${nodeId}`, { method: 'DELETE' }),

  startRun: (nodeId: string, prompt: string) =>
    json<{ runId: string }>(`/api/nodes/${nodeId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),
};

/** Subscribes to the project's event stream. Returns an unsubscribe function. */
export function subscribe(projectId: string, onEvent: (e: ServerEvent) => void): () => void {
  const source = new EventSource(`/api/events?projectId=${encodeURIComponent(projectId)}`);
  const handle = (e: MessageEvent<string>): void => {
    try {
      onEvent(JSON.parse(e.data) as ServerEvent);
    } catch {
      /* a malformed frame is not worth tearing the stream down for */
    }
  };
  for (const type of [
    'hello',
    'tree.updated',
    'node.status',
    'run.started',
    'run.delta',
    'run.question',
    'run.finished',
    'run.error',
  ]) {
    source.addEventListener(type, handle as EventListener);
  }
  return () => source.close();
}
