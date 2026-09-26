import type {
  ApplyPatchView,
  ArchiveCheck,
  StorageView,
  AdoptProjectRequest,
  ComparisonSummary,
  ComparisonView,
  CompactRequest,
  CreateReferenceRequest,
  DraftReferenceRequest,
  DraftReferenceResponse,
  ReferenceView,
  RunReferenceView,
  StartRunRequest,
  UpdateReferenceRequest,
  ChildPreviewView,
  AnswerQuestionRequest,
  ConnectionStatus,
  CreateProjectRequest,
  DeletionImpactView,
  NodeDeletionImpactView,
  DiagnosticsView,
  DirectoryInspectionView,
  DirectoryListingView,
  DiffView,
  MessageView,
  RecoverAction,
  ReviewFilePatchView,
  ReviewView,
  SettingsView,
  UpdateSettingsRequest,
  ProjectView,
  ProjectUsageView,
  UpdateProjectRequest,
  NodeDetail,
  NodeView,
  ServerEvent,
  TreeResponse,
  UpdateNodeRequest,
} from '@bonsai/shared';

import { ApiCallError } from './ApiCallError.ts';

export { ApiCallError };

/**
 * The only module in the UI that knows a server exists.
 *
 * PRD §9 constraint 5: nothing touching git, the filesystem or the agent lives
 * in UI code. Everything below is HTTP against the one API surface.
 */

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const timeout =
    init?.method === undefined || init.method === 'GET' ? AbortSignal.timeout(20_000) : null;
  const signal =
    timeout === null
      ? init?.signal
      : init?.signal
        ? AbortSignal.any([init.signal, timeout])
        : timeout;
  const res = await fetch(input, {
    ...init,
    ...(signal ? { signal } : {}),
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  }).catch((e: unknown) => {
    if (timeout?.aborted)
      throw new Error('Bonsai did not respond in time. Retry when the server is available.');
    throw e;
  });
  const body: unknown = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    const err = body as { error?: string; milestone?: string };
    throw new ApiCallError(err.error ?? res.statusText, res.status, err.milestone);
  }
  return body as T;
}

export interface NodeDiffView {
  baseLabel: string;
  files: string[];
  patch: string;
  dirty: string[];
}

export const api = {
  usage: (projectId: string) => json<ProjectUsageView>(`/api/projects/${projectId}/usage`),
  connection: () => json<ConnectionStatus>('/api/connection'),
  checkConnection: () => json<ConnectionStatus>('/api/connection/check', { method: 'POST' }),
  login: () =>
    json<{ ok: boolean; output: string; status: ConnectionStatus }>('/api/connection/login', {
      method: 'POST',
    }),

  settings: () => json<SettingsView>('/api/settings'),

  /** Everything needed to investigate a problem, assembled server-side. */
  diagnostics: (nodeId?: string | null) =>
    json<DiagnosticsView>(
      nodeId == null ? '/api/diagnostics' : `/api/diagnostics?nodeId=${encodeURIComponent(nodeId)}`,
    ),
  updateSettings: (body: UpdateSettingsRequest) =>
    json<SettingsView>('/api/settings', { method: 'PATCH', body: JSON.stringify(body) }),

  revealNode: (id: string) => json<{ ok: true }>(`/api/nodes/${id}/reveal`, { method: 'POST' }),
  applyPatch: (id: string) => json<ApplyPatchView>(`/api/nodes/${id}/patch`, { method: 'POST' }),
  archiveCheck: (id: string) => json<ArchiveCheck>(`/api/nodes/${id}/archive`),
  archive: (id: string, removeIgnored: boolean) =>
    json<{ ok: true }>(`/api/nodes/${id}/archive`, {
      method: 'POST',
      body: JSON.stringify({ removeIgnored }),
    }),
  storage: () => json<StorageView>('/api/storage'),

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

  listProjects: () => json<ProjectView[]>('/api/projects'),

  previewProject: (location: string, name: string) =>
    json<{ path: string }>('/api/projects/preview', {
      method: 'POST',
      body: JSON.stringify({ location, name }),
    }),

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

  /** Review: what an experiment changed, file by file. Counts only, never patches. */
  review: (nodeId: string, signal?: AbortSignal) =>
    json<ReviewView>(`/api/nodes/${nodeId}/review`, { signal }),

  /** One file's patch, for the pane reading it. */
  reviewFile: (
    nodeId: string,
    path: string,
    signal?: AbortSignal,
    view: 'diff' | 'file' = 'diff',
  ) =>
    json<ReviewFilePatchView>(
      `/api/nodes/${nodeId}/review/file?path=${encodeURIComponent(path)}&view=${view}`,
      {
        signal,
      },
    ),

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

  /**
   * D34: answer a question the agent stopped on. A refusal's message is the
   * only thing that reaches the agent, so it is where you say what to do
   * instead.
   */
  answerQuestion: (questionId: string, allow: boolean, message?: string) =>
    json<{ ok: true }>(`/api/questions/${questionId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ allow, message } satisfies AnswerQuestionRequest),
    }),

  /**
   * D42: answers to questions the agent asked, keyed by the question's text.
   * Every question needs one; the server refuses a partial set rather than
   * sending the agent a blank.
   */
  answerChoices: (questionId: string, answers: Record<string, string>) =>
    json<{ ok: true }>(`/api/questions/${questionId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answers } satisfies AnswerQuestionRequest),
    }),

  /** D42: answer nothing, and let the agent decide -- and say what it decided. */
  leaveToAgent: (questionId: string) =>
    json<{ ok: true }>(`/api/questions/${questionId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ agentDecides: true } satisfies AnswerQuestionRequest),
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

  /**
   * Finish now (D43): stop waiting for background work, stop it, and let the
   * run end normally so its results are committed. Unlike Stop, which cancels.
   */
  finishNow: (nodeId: string) =>
    json<{ finished: boolean }>(`/api/nodes/${nodeId}/finish`, { method: 'POST' }),

  cancelProject: (projectId: string) =>
    json<{ cancelled: number }>(`/api/projects/${projectId}/cancel`, { method: 'POST' }),

  tree: (projectId: string) => json<TreeResponse>(`/api/projects/${projectId}/tree`),

  childPreview: (nodeId: string) => json<ChildPreviewView>(`/api/nodes/${nodeId}/child-preview`),

  node: (nodeId: string, signal?: AbortSignal) =>
    json<NodeDetail>(`/api/nodes/${nodeId}`, signal ? { signal } : undefined),

  messages: (nodeId: string, afterSeq = 0, signal?: AbortSignal) =>
    json<MessageView[]>(
      `/api/nodes/${nodeId}/messages?afterSeq=${afterSeq}`,
      signal ? { signal } : undefined,
    ),

  createNode: (
    projectId: string,
    body: {
      parentId: string;
      sourceVersion?: string;
      displayName?: string;
      description: string;
      successCriteria?: string;
      verificationHint?: string;
      startFresh?: boolean;
    },
  ) =>
    json<{ node: NodeView }>(`/api/projects/${projectId}/nodes`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateNode: (nodeId: string, body: UpdateNodeRequest) =>
    json<NodeView>(`/api/nodes/${nodeId}`, { method: 'PATCH', body: JSON.stringify(body) }),

  deleteNode: (nodeId: string) =>
    json<{ ok: true; removed: number }>(`/api/nodes/${nodeId}`, { method: 'DELETE' }),

  /** Compacts the conversation now, as /compact does. Starts a run; returns its id. */
  compact: (nodeId: string, focus?: string) =>
    json<{ runId: string }>(`/api/nodes/${nodeId}/compact`, {
      method: 'POST',
      body: JSON.stringify({ focus } satisfies CompactRequest),
    }),

  startRun: (
    nodeId: string,
    prompt: string,
    attached: { referenceIds?: string[]; experimentIds?: string[] } = {},
  ) =>
    json<{ runId: string }>(`/api/nodes/${nodeId}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        ...(attached.referenceIds?.length ? { referenceIds: attached.referenceIds } : {}),
        ...(attached.experimentIds?.length ? { experimentIds: attached.experimentIds } : {}),
      } satisfies StartRunRequest),
    }),

  references: (projectId: string) => json<ReferenceView[]>(`/api/projects/${projectId}/references`),

  createReference: (projectId: string, body: CreateReferenceRequest) =>
    json<ReferenceView>(`/api/projects/${projectId}/references`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateReference: (referenceId: string, body: UpdateReferenceRequest) =>
    json<ReferenceView>(`/api/references/${referenceId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  deleteReference: (referenceId: string) =>
    json<{ ok: true }>(`/api/references/${referenceId}`, { method: 'DELETE' }),

  /** A draft from an experiment's conversation. Aborting stops the model call. */
  draftReference: (body: DraftReferenceRequest, signal: AbortSignal) =>
    json<DraftReferenceResponse>('/api/references/draft', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    }),

  /** A reference exactly as a run received it. */
  runReference: (runId: string, referenceId: string) =>
    json<RunReferenceView & { content: string }>(`/api/runs/${runId}/references/${referenceId}`),

  comparisons: (projectId: string) =>
    json<ComparisonSummary[]>(`/api/projects/${projectId}/comparisons`),

  /** Snapshots the experiments now; nothing is asked until a question is. */
  createComparison: (projectId: string, nodeIds: readonly string[]) =>
    json<ComparisonView>(`/api/projects/${projectId}/comparisons`, {
      method: 'POST',
      body: JSON.stringify({ nodeIds: [...nodeIds] }),
    }),

  comparison: (comparisonId: string, signal?: AbortSignal) =>
    json<ComparisonView>(`/api/comparisons/${comparisonId}`, signal ? { signal } : undefined),

  askComparison: (comparisonId: string, prompt: string, referenceIds: readonly string[] = []) =>
    json<{ turnId: string }>(`/api/comparisons/${comparisonId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ prompt, ...(referenceIds.length === 0 ? {} : { referenceIds }) }),
    }),

  stopComparison: (comparisonId: string) =>
    json<{ ok: true }>(`/api/comparisons/${comparisonId}/stop`, { method: 'POST' }),

  refreshComparison: (comparisonId: string) =>
    json<{ updated: string[]; comparison: ComparisonView }>(
      `/api/comparisons/${comparisonId}/refresh`,
      { method: 'POST' },
    ),

  renameComparison: (comparisonId: string, title: string) =>
    json<ComparisonView>(`/api/comparisons/${comparisonId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  deleteComparison: (comparisonId: string) =>
    json<{ ok: true }>(`/api/comparisons/${comparisonId}`, { method: 'DELETE' }),

  deletionImpact: (nodeId: string) =>
    json<NodeDeletionImpactView>(`/api/nodes/${nodeId}/deletion-impact`),
};

/** Subscribes to the project's event stream. Returns an unsubscribe function. */
export function subscribe(
  projectId: string,
  onEvent: (e: ServerEvent) => void,
  onState?: (state: 'live' | 'reconnecting') => void,
): () => void {
  const handle = (e: MessageEvent<string>): void => {
    try {
      onEvent(JSON.parse(e.data) as ServerEvent);
    } catch {
      /* a malformed frame is not worth tearing the stream down for */
    }
  };
  const connect = (): EventSource => {
    const source = new EventSource(`/api/events?projectId=${encodeURIComponent(projectId)}`);
    source.onopen = () => onState?.('live');
    source.onerror = () => onState?.('reconnecting');
    for (const type of [
      'hello',
      'tree.updated',
      'references.updated',
      'comparison.updated',
      'node.status',
      'run.started',
      'run.delta',
      'run.activity',
      'run.question',
      'run.finished',
      'run.error',
    ])
      source.addEventListener(type, handle as EventListener);
    return source;
  };
  let source = connect();
  const close = (): void => {
    source.onopen = null;
    source.onerror = null;
    source.close();
  };
  const offline = (): void => {
    close();
    onState?.('reconnecting');
  };
  const online = (): void => {
    close();
    onState?.('reconnecting');
    source = connect();
  };
  // A document in the back/forward cache can retain its React tree. Release
  // its stream on navigation, then reconcile if that document is restored.
  const resume = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      if (navigator.onLine) online();
      else offline();
    }
  };
  window.addEventListener('pagehide', close);
  window.addEventListener('pageshow', resume);
  window.addEventListener('offline', offline);
  window.addEventListener('online', online);
  return () => {
    close();
    window.removeEventListener('pagehide', close);
    window.removeEventListener('pageshow', resume);
    window.removeEventListener('offline', offline);
    window.removeEventListener('online', online);
  };
}
