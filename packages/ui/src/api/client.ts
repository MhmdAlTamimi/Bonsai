import type {
  AdoptProjectRequest,
  ConnectionStatus,
  CreateProjectRequest,
  DeletionImpactView,
  DirectoryInspectionView,
  DirectoryListingView,
  DiffView,
  MessageView,
  RecoverAction,
  SettingsView,
  UpdateSettingsRequest,
  ProjectView,
  UpdateProjectRequest,
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

export interface NodeDiffView {
  files: string[];
  patch: string;
  dirty: string[];
}

export const api = {
  connection: () => json<ConnectionStatus>('/api/connection'),
  checkConnection: () => json<ConnectionStatus>('/api/connection/check', { method: 'POST' }),
  login: () =>
    json<{ ok: boolean; output: string; status: ConnectionStatus }>('/api/connection/login', {
      method: 'POST',
    }),

  settings: () => json<SettingsView>('/api/settings'),
  updateSettings: (body: UpdateSettingsRequest) =>
    json<SettingsView>('/api/settings', { method: 'PATCH', body: JSON.stringify(body) }),

  reveal: (path: string) =>
    json<{ ok: true }>('/api/reveal', { method: 'POST', body: JSON.stringify({ path }) }),

  /**
   * The server picks the folder, because a browser cannot. A file input hands
   * over names, never locations, so there is no way to turn a native folder
   * dialog into a path the server could open -- hence a picker driven by these
   * two calls instead.
   */
  browse: (path?: string) =>
    json<DirectoryListingView>(
      path === undefined ? '/api/browse' : `/api/browse?path=${encodeURIComponent(path)}`,
    ),

  inspect: (path: string) =>
    json<DirectoryInspectionView>('/api/inspect', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  deleteProject: (projectId: string) =>
    json<{
      ok: true;
      nodes: number;
      removedDirectory: string | null;
      keptDirectory: string | null;
    }>(`/api/projects/${projectId}`, { method: 'DELETE' }),

  projectDeletionImpact: (projectId: string) =>
    json<DeletionImpactView>(`/api/projects/${projectId}/deletion-impact`),

  listProjects: () => json<Array<{ id: string; name: string }>>('/api/projects'),

  createProject: (body: CreateProjectRequest) =>
    json<{ projectId: string; masterNodeId: string; path: string }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Uses a folder the user already has, in place. Nothing is copied or moved. */
  adoptProject: (body: AdoptProjectRequest) =>
    json<{
      projectId: string;
      masterNodeId: string;
      initialised: boolean;
      snapshot: boolean;
    }>('/api/projects/adopt', { method: 'POST', body: JSON.stringify(body) }),

  diff: (nodeId: string) => json<NodeDiffView>(`/api/nodes/${nodeId}/diff`),

  runDiff: (runId: string) => json<DiffView>(`/api/runs/${runId}/diff`),

  recover: (nodeId: string, action: RecoverAction) =>
    json<{ ok: true }>(`/api/nodes/${nodeId}/recover`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),

  updateProject: (projectId: string, body: UpdateProjectRequest) =>
    json<ProjectView>(`/api/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  cancelRun: (runId: string) =>
    json<{ cancelled: boolean }>(`/api/runs/${runId}/cancel`, { method: 'POST' }),

  /**
   * Stop a node. Preferred over cancelRun everywhere in the interface: it needs
   * nothing but the id already on the card, so stop works the instant a node
   * starts running rather than once its detail has been fetched.
   */
  cancelNode: (nodeId: string) =>
    json<{ cancelled: boolean }>(`/api/nodes/${nodeId}/cancel`, { method: 'POST' }),

  cancelProject: (projectId: string) =>
    json<{ cancelled: number }>(`/api/projects/${projectId}/cancel`, { method: 'POST' }),

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
    json<{ ok: true; removed: number }>(`/api/nodes/${nodeId}`, { method: 'DELETE' }),

  startRun: (nodeId: string, prompt: string) =>
    json<{ runId: string }>(`/api/nodes/${nodeId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),

  deletionImpact: (nodeId: string) =>
    json<{ nodes: number; costUsd: number; commits: number }>(
      `/api/nodes/${nodeId}/deletion-impact`,
    ),
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
