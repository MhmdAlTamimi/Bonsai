/**
 * The API contract between the backend and the UI.
 *
 * This is the only module both sides import, which is how PRD §9 constraint 5
 * ("nothing touching git, the filesystem, or the agent lives in UI code") is
 * enforced by the module graph rather than by discipline. Note what is *absent*
 * from `NodeView`: branch names, worktree paths, session ids and commit shas.
 * The UI cannot misuse a path it was never given.
 */

/** PRD §5. Exactly five. `failed` is not a state; it is a run with an error. */
export type NodeStatus = 'new' | 'running' | 'needs_you' | 'ready' | 'interrupted';

export const NODE_STATUSES: readonly NodeStatus[] = [
  'new',
  'running',
  'needs_you',
  'ready',
  'interrupted',
];

export type RunStatus = 'running' | 'done' | 'cancelled' | 'failed';

/** D32: project default, per-node override. */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

/** D32: 'low' through 'max'. Null means the SDK's own default. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Whether Bonsai can reach Claude. Established by a real query, never guessed
 * from the filesystem — see server/agent/connection.ts for why that matters.
 */
export type ConnectionState =
  | 'connected'
  | 'no_credential'
  | 'rate_limited'
  | 'error'
  /** Not checked yet, or a check is in flight. */
  | 'unknown';

export interface ConnectionStatus {
  state: ConnectionState;
  /** Which credential answered: 'none' is a claude.ai subscription login. */
  apiKeySource: string | null;
  model: string | null;
  /** The underlying error, when there is one. Shown verbatim; never invented. */
  message: string | null;
}

export interface SettingsView {
  /** How Bonsai authenticates. 'cli' uses whatever `claude login` stored. */
  authMode: 'cli' | 'api_key';
  /** Whether a key is stored. The key itself is never sent to the UI. */
  hasStoredApiKey: boolean;
  model: string | null;
  permissionMode: PermissionMode;
  effort: string | null;
  /** Where the database and repositories live. */
  dataDir: string;
  reposRoot: string;
  platform: string;
}

export interface UpdateSettingsRequest {
  authMode?: 'cli' | 'api_key';
  /** Empty string clears the stored key. */
  apiKey?: string;
  model?: string | null;
  permissionMode?: PermissionMode;
  effort?: string | null;
  reposRoot?: string;
}

export interface ProjectView {
  id: string;
  name: string;
  description: string;
  /** Null means whatever the Agent SDK defaults to. */
  defaultModel: string | null;
  defaultPermissionMode: PermissionMode;
  defaultEffort: string | null;
  /**
   * 'created' — Bonsai made the repository and owns it outright.
   * 'adopted' — the user pointed Bonsai at a directory they already had, so
   * Bonsai's nodes are branches inside THEIR repository and deleting the
   * project must not touch their files.
   */
  sourceKind: 'created' | 'adopted';
  /**
   * The project's working folder — master's checkout, and the path "reveal in
   * file manager" opens. Whose it is depends on `sourceKind`: Bonsai's when
   * created, the user's when adopted. Null only for projects made before this
   * was recorded.
   */
  sourcePath: string | null;
  /** Estimated total across every run in the tree, at API list price. */
  costUsd: number;
  createdAt: string;
}

export interface UpdateProjectRequest {
  model?: string | null;
  effort?: string | null;
}

/**
 * What the canvas renders. Flags, never a type string (PRD §9 constraint 4).
 *
 * `createsBranch` and `writable` are both *derived server-side on every read*:
 *   createsBranch = headCommit !== null      (an outcome of a run, not a choice)
 *   writable      = no child has committed   (NOT `isLeaf` — see docs/decisions)
 * They are not columns, so they cannot drift out of step with the tree.
 */
/**
 * Why a node is not writable. Null when it is.
 *
 * Not a node type — `writable` remains the flag everything gates on, and this
 * only says which of the two reasons produced it. There are two because they
 * lead to different advice: a frozen node is finished and you branch off it,
 * whereas your own folder was never going to be written to at all.
 */
export type FrozenReason = 'child_committed' | 'your_folder';

export interface NodeView {
  id: string;
  projectId: string;
  parentId: string | null;
  displayName: string;
  /** The change description, or the agent's question when status is needs_you. */
  summaryLine: string;
  status: NodeStatus;
  createsBranch: boolean;
  writable: boolean;
  frozenReason: FrozenReason | null;
  /** Rendering hint only. Deliberately not part of the `writable` derivation. */
  isLeaf: boolean;
  hasCommits: boolean;
  pendingQuestion: { id: string; text: string } | null;
  positionX: number | null;
  positionY: number | null;
  costUsd: number;
  createdAt: string;
}

export interface RunView {
  id: string;
  nodeId: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  /**
   * An ESTIMATE at API list price, from the SDK's own figure (D20). It is not a
   * billing statement, and on a subscription login nothing is charged per token
   * at all -- there it says what these tokens would have cost through the API.
   */
  costUsd: number;
  /** Replayed context served from cache, which costs a fraction of fresh input. */
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Which model actually ran. Null for stand-in runs and for older rows. */
  model: string | null;
  /**
   * Which credential paid. 'none' is a claude.ai subscription login, where
   * nothing is charged per token — there `costUsd` is an API-equivalent figure
   * and not money that moved.
   */
  apiKeySource: string | null;
  /** The commit this run produced, or null when it changed nothing. */
  commitSha: string | null;
  error: string | null;
}

export interface DiffView {
  files: string[];
  patch: string;
  dirty: string[];
}

export interface MessageView {
  id: string;
  nodeId: string;
  runId: string | null;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  kind: 'text' | 'tool_use' | 'tool_result' | 'result';
  content: unknown;
  createdAt: string;
}

export interface NodeDetail {
  node: NodeView;
  runs: RunView[];
  /** D22: a human-readable record shown in the panel. Null until a run commits one. */
  contextMd: string | null;
  /**
   * Diagnostic only, and deliberately not a commit sha: whether this node's
   * pinned git base still agrees with what a live walk up the tree would say.
   * They diverge when an ancestor commits after this node was created, which is
   * expected and correct — the pin is what keeps a child's code and its
   * inherited conversation describing the same tree.
   */
  baseIsPinnedBehindLiveWalk: boolean;
}

export interface TreeResponse {
  project: ProjectView;
  nodes: NodeView[];
}

export interface CreateProjectRequest {
  name: string;
  description: string;
  model?: string | null;
  permissionMode?: PermissionMode;
  /**
   * Where to put the project's working folder. Bonsai creates a new folder
   * named after the project inside it and owns everything in it. Omitted means
   * Bonsai's own data directory.
   */
  location?: string;
}

export interface AdoptProjectRequest {
  /** A folder the user already has. Used in place; never copied or moved. */
  path: string;
  name?: string;
  description?: string;
  /** Branch nodes from uncommitted work, without committing it to their branch. */
  includeUncommitted?: boolean;
}

export interface DirectoryInspectionView {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  branch: string | null;
  headCommit: string | null;
  dirtyFiles: number;
  entryCount: number;
  blockedReason: string | null;
}

/** What deleting something would destroy, so the UI can say so before it does. */
export interface DeletionImpactView {
  nodes: number;
  costUsd: number;
  commits: number;
  /** A directory that will be removed from disk, or null when none is. */
  removesDirectory: string | null;
  /** The user's own directory, left exactly as it was. Adopted projects only. */
  keepsDirectory: string | null;
  /** Branches Bonsai created inside the user's repository and will remove. */
  branches: number;
}

export interface DirectoryListingView {
  path: string;
  parent: string | null;
  home: string;
  entries: Array<{ name: string; path: string; isGitRepo: boolean }>;
}

export interface CreateNodeRequest {
  parentId: string;
  displayName: string;
  description: string;
  model?: string | null;
  permissionMode?: PermissionMode;
}

export interface UpdateNodeRequest {
  displayName?: string;
  positionX?: number | null;
  positionY?: number | null;
}

export interface StartRunRequest {
  prompt: string;
}

export type RecoverAction = 'resume' | 'discard' | 'keep';

export interface RecoverRequest {
  action: RecoverAction;
}

/** Server-sent events. One stream per project. */
export type ServerEvent =
  | { type: 'hello'; projectId: string }
  | { type: 'tree.updated'; projectId: string }
  | { type: 'node.status'; nodeId: string; status: NodeStatus }
  | { type: 'run.started'; nodeId: string; runId: string }
  | { type: 'run.delta'; nodeId: string; runId: string; seq: number; text: string }
  | { type: 'run.question'; nodeId: string; runId: string; questionId: string; text: string }
  | {
      type: 'run.finished';
      nodeId: string;
      runId: string;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
    }
  | { type: 'run.error'; nodeId: string; runId: string; error: string };

export interface ApiError {
  error: string;
  /** Set when a route exists but its milestone has not landed yet. */
  milestone?: string;
}
