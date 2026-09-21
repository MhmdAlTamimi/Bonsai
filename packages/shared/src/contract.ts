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
  /** How Bonsai authenticates. 'cli' uses whatever `claude auth login` stored. */
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
  /** How many agents may run at once; the rest queue. */
  maxConcurrentRuns: number;
  /**
   * Width of the side panel, in pixels.
   *
   * A view preference rather than app state, but it lives here because the
   * project's rule is that nothing persists in browser storage — and this is
   * the one place preferences already are.
   */
  panelWidth: number;
  textScale: number;
  wrapLines: boolean;
}

/**
 * How wide the side panel may be dragged, and where it starts.
 *
 * Shared because both ends enforce it: the drag handler so the divider stops,
 * and the server so a bad stored value cannot come back on every launch. Two
 * copies of these numbers would eventually disagree.
 */
export const TEXT_SCALES = [100, 115, 130] as const;

export const PANEL_WIDTH = { min: 280, max: 900, default: 380 } as const;

/**
 * How wide the conversation is beside a diff: three quarters of its width on
 * the canvas. Review is where the diff deserves the room, and every part of
 * the panel keeps its type size — only the wrap changes.
 */
export const REVIEW_WIDTH = 285;

/**
 * How many agents may run at once.
 *
 * "Run several experiments in parallel" is the product, so this is not a
 * throttle bolted on out of caution -- it is what keeps the parallelism usable.
 * Ten agents started together do not finish ten times sooner; they contend for
 * CPU and memory until the machine stops responding, in the one place the
 * product is meant to shine.
 */
export const CONCURRENCY = { min: 1, max: 10, default: 3 } as const;

export interface UpdateSettingsRequest {
  authMode?: 'cli' | 'api_key';
  /** Empty string clears the stored key. */
  apiKey?: string;
  model?: string | null;
  permissionMode?: PermissionMode;
  effort?: string | null;
  reposRoot?: string;
  /** Clamped server-side; see settings.ts for the bounds and why. */
  panelWidth?: number;
  textScale?: number;
  wrapLines?: boolean;
  maxConcurrentRuns?: number;
}

/**
 * Everything needed to investigate a problem, in one block of text.
 *
 * Assembled server-side rather than by the interface, because most of it --
 * versions, paths, log lines -- is not in the contract and should not be. The
 * point is that reporting a bug costs one click instead of a conversation.
 *
 * The API key is never here. Whether one is stored is, which is the part that
 * changes behaviour.
 */
export interface DiagnosticsView {
  generatedAt: string;
  app: { node: string; platform: string; arch: string };
  paths: { dataDir: string; reposRoot: string; logDir: string };
  agent: {
    authMode: 'cli' | 'api_key';
    hasStoredApiKey: boolean;
    model: string | null;
    effort: string | null;
    permissionMode: PermissionMode;
    standIn: boolean;
  };
  connection: ConnectionStatus;
  counts: { projects: number; nodes: number; runs: number; running: number };
  /** Filtered log events, oldest first. Free-form text fields are omitted. */
  log: string[];
  /** The selected node's runs, when one was named. */
  node: {
    id: string;
    displayName: string;
    status: NodeStatus;
    writable: boolean;
    frozenReason: FrozenReason | null;
    runs: RunView[];
  } | null;
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
  /**
   * D37: the agent's working directory inside the repository, '/'-separated,
   * '' for the repository root itself.
   *
   * Bonsai opens a folder the way an editor does. `sourcePath` is the
   * repository -- the project's identity, whose history, branches and commits
   * stay whole -- and this is the folder inside it the agent stands in.
   */
  workDir: string;
  /** `sourcePath` and `workDir` joined: the folder to reveal or name. */
  workPath: string | null;
  /**
   * The branch the project's own repository is on — `main`, `master`, whatever
   * an adopted repository uses.
   *
   * Null for a project Bonsai created, where the only branches are the
   * `node/<uuid>` ones an experiment owns, and D33 says those are never shown:
   * they are generated once, never renamed, and mean nothing to anyone.
   */
  branchLabel: string | null;
  setup: ProjectSetupView;
  /** Estimated total across every run in the tree, at API list price. */
  costUsd: number;
  createdAt: string;
}

export interface UpdateProjectRequest {
  permissionMode?: PermissionMode;
  model?: string | null;
  effort?: string | null;
  /** Paths relative to the project folder. Validated; see the response. */
  copyFiles?: string[];
  setupCommand?: string | null;
}

/**
 * Per-project, not per-app, because the answer is a property of the project.
 * One needs `uv sync`, the next needs `npm install`, and a single global
 * setting would be wrong for every project but the one it was typed for.
 */
export interface ProjectSetupView {
  /** Copied into each new node's worktree. Empty is normal and fine. */
  copyFiles: string[];
  /** Run once in a new node's folder before its first agent run. */
  setupCommand: string | null;
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
  /** Why the newest run ended, or null while it runs or before there is one. */
  lastRunEndReason: RunEndReason | null;
  createsBranch: boolean;
  writable: boolean;
  frozenReason: FrozenReason | null;
  /** Rendering hint only. Deliberately not part of the `writable` derivation. */
  isLeaf: boolean;
  hasCommits: boolean;
  pendingQuestion: {
    id: string;
    /** One line, for the card. The question itself, or the permission being asked for. */
    text: string;
    /**
     * What kind of answer the agent is waiting for.
     *
     *   permission -- may it do this? Allow, or refuse with a reason.
     *   choice     -- it asked you something (AskUserQuestion). Answer, or
     *                 leave the decision to it.
     *
     * Both park the run the same way and share the Needs you status; they
     * differ only in what an answer is.
     */
    kind: 'permission' | 'choice';
    request?: { action: string; target: string; details: string };
    questions?: AgentQuestion[];
  } | null;
  positionX: number | null;
  positionY: number | null;
  /**
   * How much this node changed, against its base. Null when it has committed
   * nothing -- which the card renders as nothing at all, rather than "0 files".
   */
  diffStat: { files: number; added: number; removed: number } | null;
  costUsd: number;
  /**
   * 1-based place in the queue when this node is waiting for a free slot, and
   * null when it is not waiting.
   *
   * Derived, never stored, and deliberately NOT a sixth node status: there are
   * exactly five, the schema constrains them, and a queued node genuinely is
   * `running` from the user's point of view -- they asked for it, it is going
   * to happen, and nothing else about it differs.
   */
  queuePosition: number | null;
  /** Active/queued execution identity; absent on older server responses. */
  activeRunId?: string | null;
  /**
   * What the run is doing right now, or null when nothing is running.
   *
   * Derived in memory like `queuePosition`, and for the same reason not a
   * status: waiting for background work is still `running` -- the run has not
   * ended, its work has not been committed, and Stop still applies.
   */
  activity: RunActivity | null;
  createdAt: string;
}

/**
 * The live state of one run (D43).
 *
 * A run used to end when the agent's turn ended. That was wrong for any
 * command still running in the background: Bonsai committed and said
 * Finished while the experiment kept writing files. Now the run stays open
 * while that work is live, and this is how the interface says so.
 */
export interface RunActivity {
  /**
   * working -- the agent is taking a turn.
   * waiting -- its turn is over, and background work it started is still
   *            running. The run ends when that work does, or on Finish now.
   */
  state: 'working' | 'waiting';
  /** The tool call in progress, so a long command reads as running rather than stuck. */
  tool: { name: string; detail: string; startedAt: string } | null;
  background: BackgroundJob[];
}

export interface BackgroundJob {
  id: string;
  /** The agent's description of a tracked job, or the command line of a detached process. */
  description: string;
  /**
   * true  -- started in the agent's background mode, so the harness knows when
   *          it ends and wakes the agent.
   * false -- detached some other way (nohup, a trailing &) and found by Bonsai
   *          through the run's marker; nothing tells the agent when it ends.
   */
  tracked: boolean;
  /** When Bonsai first saw it. */
  startedAt: string;
}

/**
 * One question the agent asked, in the shape the SDK's AskUserQuestion tool
 * uses -- kept identical so nothing is lost or reinterpreted on the way to the
 * panel.
 *
 * There is deliberately no "Other" option in `options`. The tool tells the
 * agent not to add one because the host always offers free text, so the panel
 * must: an answer is any string, not only an option's label.
 */
export interface AgentQuestion {
  question: string;
  /** A short label, at most a few words. */
  header: string;
  /** True when several options may be chosen together. */
  multiSelect: boolean;
  options: Array<{
    label: string;
    description: string;
    /** Code or a mockup to compare options by, shown in monospace. */
    preview?: string;
  }>;
}

/**
 * Why a run ended (D45). Recovery is worded by this, because the four need
 * different words: "you stopped this run" is not "Bonsai closed while it was
 * working", and neither is an error.
 */
export type RunEndReason = 'finished' | 'stopped' | 'failed' | 'app_closed';

export interface RunView {
  id: string;
  nodeId: string;
  status: RunStatus;
  /** Null while the run is still going. */
  endReason: RunEndReason | null;
  /** Background jobs and detached processes that were still running and had to be stopped. */
  stoppedBackground: number;
  /** What this run alone changed, against the commit before it. Null when it committed nothing. */
  change: { files: number; added: number; removed: number } | null;
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
  /**
   * The tools the agent was actually offered on this run.
   *
   * Kept because it is the only thing that distinguishes "the agent chose not
   * to edit anything" from "the agent was never given a way to". Those look
   * identical in a transcript and have opposite fixes.
   */
  toolsOffered: string[] | null;
  toolCalls: number;
  /** Wall-clock, in milliseconds. Null for runs recorded before this existed. */
  durationMs: number | null;
  /** What went wrong, for a failed run. Stops and app exits say so through `endReason`. */
  error: string | null;
}

/**
 * Review: one experiment's changes, as a list of files.
 *
 * `A` added · `M` modified · `D` deleted · `R` renamed · `U` in the folder and
 * not tracked yet. Counts per file, never a patch: the patch for the one file
 * being read is fetched on its own.
 */
export type ReviewStatus = 'A' | 'M' | 'D' | 'R' | 'U';

export interface ReviewFile {
  path: string;
  /** Where a renamed file came from. */
  oldPath?: string;
  status: ReviewStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** True for work in the folder that no commit holds yet. */
  uncommitted?: boolean;
}

export interface ReviewView {
  nodeId: string;
  displayName: string;
  /** What the files are compared with, in words. */
  baseLabel: string;
  totals: { files: number; added: number; removed: number };
  files: ReviewFile[];
}

export interface ReviewFilePatchView {
  content?: string;
  contentRevision?: 'current' | 'before-deletion';
  file: ReviewFile;
  patch: string;
  /** True when the patch was too large and only its beginning is here. */
  truncated: boolean;
}

export interface DiffView {
  files: string[];
  patch: string;
  dirty: string[];
}

/**
 * What a tool call produced, kept for the two blocks the conversation draws:
 * a command with its output, and an edit with its changed lines.
 *
 * Captured because a transcript that says only "Bash" and "Edit" cannot answer
 * "what did it actually run, and what did that change?" -- which is the whole
 * question a reader has. Trimmed at capture: a command that prints a megabyte
 * is worth three lines and a count of the rest.
 */
export interface ToolDiffLine {
  kind: 'add' | 'del' | 'context';
  text: string;
  /** Line numbers from the file's own patch; absent on the side that has none. */
  oldLine?: number;
  newLine?: number;
}

export interface ToolResultContent {
  /** The tool call this answers, so the two halves can be drawn as one block. */
  toolUseId: string;
  /** Bash, Edit, Write — the tool that ran. */
  name: string;
  /** False when the tool reported an error. */
  ok: boolean;
  /** A command's output, oldest first and already trimmed. */
  output?: string[];
  /** Output lines left out of `output`. */
  dropped?: number;
  /** An edit or a write: which file, and what changed in it. */
  edit?: {
    path: string;
    added: number;
    removed: number;
    lines: ToolDiffLine[];
    /** True when more changed lines exist than are kept here. */
    truncated?: boolean;
  };
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

/**
 * The two things a node inherits, named rather than left to be inferred.
 *
 * PRD §4: a node forks its parent's CONVERSATION, but its CODE branches from
 * the nearest ancestor that actually has a commit -- which is not the parent
 * whenever the parent changed no files. The decision log calls that divergence
 * the single easiest thing in the design to get subtly wrong, and the panel
 * showing a node it happens to never said a word about it.
 *
 * Resolved server-side because the walk is the server's to do (PRD §9
 * constraint 3, and `domain/lineage.ts` is where the rule lives). The interface
 * could reach the same answer from the tree it already holds, and that second
 * implementation is exactly what would eventually disagree with the first.
 * Names, never commits: nothing git-shaped crosses into the UI.
 */
export interface NodeLineageView {
  /** The node whose conversation this one forked. Null for master. */
  conversationFrom: { id: string; displayName: string } | null;
  /** The nearest ancestor with commits: where this node's code starts. */
  codeFrom: { id: string; displayName: string } | null;
  /** True when those are two different nodes. The divergence, as a flag. */
  diverged: boolean;
}

export interface NextRunSettings {
  model: string | null;
  effort: string | null;
  permissionMode: PermissionMode;
  modelSource: 'experiment' | 'project' | 'app';
  effortSource: 'project' | 'app';
  permissionSource: 'experiment' | 'project';
}

export interface ProjectUsageView {
  projectId: string;
  experiments: Array<{
    id: string;
    name: string;
    runs: Array<
      Pick<
        RunView,
        | 'id'
        | 'status'
        | 'startedAt'
        | 'model'
        | 'apiKeySource'
        | 'costUsd'
        | 'inputTokens'
        | 'outputTokens'
        | 'cacheReadTokens'
        | 'cacheCreationTokens'
      >
    >;
  }>;
}

export interface ChildPreviewView {
  nextRunSettings: NextRunSettings;
  setup: ProjectSetupView;
  sourceVersion: string;
  lineage: NodeLineageView;
  parentActive: boolean;
  conversationNote: string;
  codeNote: string;
}

export interface NodeDetail {
  nextRunSettings: NextRunSettings;
  node: NodeView;
  runs: RunView[];
  lineage: NodeLineageView;
  /**
   * A shell command that puts this node's branch in front of the user, ready
   * to copy. Null for a node that has committed nothing, since there is no
   * branch yet.
   *
   * A ready-made STRING rather than a branch name, deliberately: NodeView and
   * NodeDetail carry nothing git-shaped, so the interface cannot misuse a ref
   * or a path it was never given. It also lets the command differ by project
   * kind without the interface knowing that projects have kinds.
   */
  checkoutCommand: string | null;
  /** Where to run it, in words. */
  checkoutHint: string | null;
  /** What the user said success looks like, as they wrote it. */
  successCriteria: string | null;
  verificationHint: string | null;
  /**
   * The `## Testing` section the agent wrote into CONTEXT.md, on its own.
   *
   * Split out because it is the answer to the question this whole feature
   * exists for, and burying it in the middle of a file behind a disclosure
   * would waste it. Null when the agent wrote no such section -- which is
   * normal for a conversation-only node, since it changed nothing to test.
   */
  testingNotes: string | null;
  testingSource: {
    nodeId: string;
    nodeName: string;
    runId: string;
    recordedAt: string;
    inherited: boolean;
    predatesLatestRun: boolean;
  } | null;
  partialWork: { changed: string[]; untracked: string[]; patch: string } | null;
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
  expectedPath?: string;
}

export interface AdoptProjectRequest {
  /**
   * A folder the user already has. Used in place; never copied or moved.
   *
   * It need not be a repository root. If it sits inside one, that repository
   * becomes the project and this folder becomes the agent's working directory
   * inside it (D37).
   */
  path: string;
  name?: string;
  description?: string;
  /** Branch nodes from uncommitted work, without committing it to their branch. */
  includeUncommitted?: boolean;
}

/**
 * A folder that already belongs to a Bonsai project.
 *
 * Bonsai knows its own worktrees, so pointing the picker at one should produce
 * a name and a way to open it rather than a sentence about git internals.
 */
export interface KnownFolderView {
  projectId: string;
  projectName: string;
  /** Set when the folder is a specific node's worktree, rather than the project's. */
  nodeId: string | null;
  nodeName: string | null;
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
  /**
   * The repository this folder belongs to: the nearest enclosing one, which is
   * the repository the user's own git commands would act on standing here.
   * Null when the folder is in no repository at all, in which case adopting it
   * creates one where it is.
   */
  repoRoot: string | null;
  /** The folder relative to `repoRoot`. '' when it IS the repository root. */
  workDir: string;
  /** Non-null when this folder is already part of a project Bonsai is running. */
  knownTo: KnownFolderView | null;
}

/** What deleting something would destroy, so the UI can say so before it does. */
export interface DeletionImpactView {
  nodes: number;
  costUsd: number;
  commits: number;
  /** A directory that will be removed from disk, or null when none is. */
  removesDirectory: string | null;
  /** All app-owned directories removed, including separate managed storage. */
  removesDirectories: string[];
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
  sourceVersion?: string;
  parentId: string;
  /**
   * Optional. Left out, it is derived from the description.
   *
   * A name is metadata that changes freely (D3 constrains node code, not
   * labels), so a derived one that is slightly wrong costs a rename — while
   * requiring one costs a decision before every experiment.
   */
  displayName?: string;
  description: string;
  model?: string | null;
  permissionMode?: PermissionMode;
  /**
   * "What should be true when this works?" and "How should the agent check it?"
   *
   * Both optional, and nothing is gated on them: empty means exactly the
   * behaviour that existed before they did. Asked here rather than afterwards
   * because node creation is the one moment the answer is actually known.
   */
  successCriteria?: string;
  verificationHint?: string;
}

export interface UpdateNodeRequest {
  displayName?: string;
  positionX?: number | null;
  positionY?: number | null;
}

export interface StartRunRequest {
  prompt: string;
}

/**
 * D34: the answer to a question an agent stopped on mid-run.
 *
 * `message` reaches the agent only on a refusal — the SDK delivers a denial's
 * message as the tool's result, and an approval has no such channel. So a "no"
 * can say what to do instead; a "yes" is just a yes.
 */
export interface AnswerQuestionRequest {
  /** Permission questions: yes or no. */
  allow?: boolean;
  /** Permission questions: sent to the agent with a refusal. */
  message?: string;
  /**
   * Choice questions: each question's text to its answer. A multi-select
   * answer is its labels joined with ", ", which is the form the SDK hands the
   * agent. Every question must be answered.
   */
  answers?: Record<string, string>;
  /** Choice questions: answer nothing, and let the agent decide and say what it assumed. */
  agentDecides?: boolean;
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
  | {
      type: 'run.delta';
      nodeId: string;
      runId: string;
      seq: number;
      text: string;
      tool?: { name: string; detail: string; id?: string };
      /** What a tool produced, when this delta is a result rather than a call. */
      toolResult?: ToolResultContent;
    }
  | { type: 'run.question'; nodeId: string; runId: string; questionId: string; text: string }
  /** At most about once a second per run, so a long command cannot flood the stream. */
  | { type: 'run.activity'; nodeId: string; runId: string; activity: RunActivity }
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
}
