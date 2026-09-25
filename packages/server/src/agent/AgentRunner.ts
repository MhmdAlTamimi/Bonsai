import type { AgentQuestion, BackgroundJob, RunActivity, ToolResultContent } from '@bonsai/shared';

/** Runner boundary shared by the real SDK adapter and deterministic test runner. */
export interface RunSpec {
  runId: string;
  nodeId: string;
  /** The agent's working directory inside the experiment checkout; not a sandbox. */
  cwd: string;
  /** Repository-root notes path, independent of the selected working subdirectory. */
  contextPath?: string;
  prompt: string;
  /**
   * The prompt is a Claude Code command such as `/compact`, to be sent exactly
   * as written. Nothing is appended -- no run context, no definition of done --
   * because anything after a command becomes its arguments. Absent for an
   * ordinary message.
   */
  isCommand?: boolean;
  /**
   * References the user attached to this message, as files to read. The agent
   * is told their names and where they are, and may read outside its working
   * directory to reach them; their text is never pasted into the prompt.
   */
  references?: ReadonlyArray<{ name: string; path: string }>;
  /**
   * Other experiments the user referred to in this message, each a folder of
   * files (its conversation, its committed changes, its notes) to read when
   * the request needs them. Never pasted into the prompt either.
   */
  experiments?: ReadonlyArray<{ name: string; path: string }>;
  /** The run's own folder holding both, which the agent may read outside its checkout. */
  attachmentsFolder?: string | null;
  /**
   * The node's OWN session, to continue, or null when it has none yet.
   *
   * Always the node's own: a child's copy of its parent's conversation is made
   * once, at creation, by `forkConversation`, so by the time the child runs the
   * session it resumes already belongs to it. A run never writes into another
   * node's session.
   */
  resumeSessionId: string | null;
  /** D18: read-only tools. True for frozen nodes, which stay conversational. */
  readOnly: boolean;
  /**
   * What the user said success looks like for this node, and how they suggested
   * checking it. Both null unless they answered at creation.
   *
   * Passed on EVERY run of the node, not just the first: whether the work is
   * done should not depend on which message happened to trigger the run.
   */
  successCriteria: string | null;
  verificationHint: string | null;
  model: string | null;
  /** D32: 'low' | 'medium' | 'high' | 'xhigh' | 'max', or null for the SDK default. */
  effort: string | null;
  permissionMode: string;
  /** Extra environment for the agent subprocess, e.g. a stored API key. */
  agentEnv: Record<string, string> | null;
  /**
   * How the run asks the user whether it may do something, or null when it may
   * not ask and everything is approved automatically.
   *
   * This is the mechanism behind `needs_you` (D34). The runner does not know
   * what parking a run means -- it awaits a promise. The pipeline decides that
   * awaiting one means writing a question, flipping the node's status and
   * waiting for an answer from the interface.
   *
   * Null unless the run's permission mode is `default`. Under `acceptEdits` or
   * `bypassPermissions` the user has already said not to be asked, and a gate
   * that ignored that would be a worse bug than no gate at all.
   */
  ask: ((request: PermissionRequest) => Promise<PermissionDecision>) | null;
  /**
   * How the run puts a question to the user when the AGENT decides to ask one
   * (its AskUserQuestion tool), as opposed to asking permission.
   *
   * D42: provided in EVERY permission mode, read-only runs included. That is
   * the difference from `ask`, and it is deliberate: a permission mode says
   * whether Bonsai should check before the agent acts, and the agent asking a
   * question is not an action. Tying the two together is what made the
   * question silently vanish -- the tool returned at once with no answer, and
   * the agent wrote "I'll wait for the user" to a run that had already ended.
   *
   * Null only where no pipeline is driving the run (tests, probes). A runner
   * given null must still not pretend the user answered.
   */
  askChoices: ((request: ChoiceRequest) => Promise<ChoiceDecision>) | null;
  /** Stop: end the run now, and stop what it started. The run is cancelled. */
  signal: AbortSignal;
  /**
   * Finish now (D43): stop waiting for background work, stop it, and end the
   * run the ordinary way -- so it commits, unlike Stop.
   *
   * A run stays open while work the agent started in the background is still
   * live, however long that takes; there is deliberately no timeout, because
   * a training run and a dev server look the same from here. This is how the
   * user ends the second kind.
   */
  finishNow: AbortSignal;
  /**
   * Told what the run is doing whenever that changes: the tool in progress,
   * and whether it is waiting for background work. A callback rather than a
   * RunEvent because it changes while no event is due -- a job ending while
   * the agent is idle is exactly when the interface most needs to hear.
   */
  onActivity: (activity: RunActivity) => void;
  /**
   * Processes this run started that the harness is not tracking -- detached
   * with nohup, setsid or a trailing & -- and that are still running. Found by
   * the run's marker, so the runner stays unaware of how (D43).
   */
  backgroundLeftovers: () => Promise<BackgroundJob[]>;
}

/** Questions the agent wants answered, exactly as it asked them. */
export interface ChoiceRequest {
  questions: AgentQuestion[];
}

/**
 * What came back. Not answering is a real outcome rather than a missing one:
 * the user can leave the decision to the agent, or stop the run, and in both
 * cases the agent is told so in words it can act on.
 */
export type ChoiceDecision =
  { answered: true; answers: Record<string, string> } | { answered: false; reason: string };

/** A tool call the agent wants to make, held until someone decides. */
export interface PermissionRequest {
  toolName: string;
  /** Full action input, recorded for reviewing this specific permission request. */
  details?: string;
  /** The same one-line summary the transcript shows for a tool call. */
  detail: string;
}

/**
 * The answer. A refusal carries words because that is the only channel back to
 * the agent: the SDK delivers a denial's message as the tool's result, so "no,
 * use the existing helper" steers the run instead of merely stopping it. An
 * approval has no such channel, which is why it carries nothing.
 */
export type PermissionDecision = { allow: true } | { allow: false; reason: string };

export type RunEvent =
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      name: string;
      detail: string;
      id?: string;
      parentToolUseId?: string;
      /** What the agent said the call is for ("Run the tests"), when it said. */
      description?: string;
    }
  /** What a tool produced: a command's output, or an edit's changed lines. */
  | { type: 'tool_result'; result: ToolResultContent }
  | { type: 'session'; sessionId: string }
  /**
   * Where the conversation has got to: the harness's id for the latest message
   * the main agent wrote. The pipeline keeps the last one from each FINISHED
   * run, so a child forked later copies up to the end of a completed exchange
   * rather than into the middle of one that is still going.
   */
  | { type: 'position'; messageId: string }
  /** Which model the run is actually using, and which credential is paying. */
  | { type: 'model'; model: string; apiKeySource?: string; tools?: string[] }
  | {
      type: 'done';
      inputTokens: number;
      outputTokens: number;
      /** An ESTIMATE at list price (D20). Not a bill, and not what a subscription charges. */
      costUsd: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      model?: string | null;
    }
  /** Older turns were summarised to free context; the numbers are the harness's. */
  | {
      type: 'compacted';
      trigger: 'manual' | 'auto';
      tokensBefore: number;
      tokensAfter: number | null;
    }
  /** Something the harness said about the run rather than the agent saying it. */
  | { type: 'notice'; text: string }
  | { type: 'error'; error: string };

export interface AgentRunner {
  run(spec: RunSpec): AsyncIterable<RunEvent>;
}

/**
 * Copies conversations, apart from any run. Its own interface because only
 * node creation needs it; the runners that drive real and stand-in agents
 * implement both.
 */
export interface ConversationCopier {
  /**
   * Copies a session into a new one that can be resumed on its own, and
   * returns the new id. The source is untouched.
   *
   * `upToMessageId` cuts the copy at that message (inclusive); null copies all
   * of it. No model call is made -- this is a transcript copy, which is why it
   * can happen at node creation.
   */
  forkConversation(sessionId: string, upToMessageId: string | null): Promise<string>;
}

/**
 * One model turn with no tools: read the input, write text, nothing else.
 *
 * What drafts a reference from a conversation. It is deliberately not an
 * agent: it cannot read files, run commands or change anything, and that is
 * enforced by how it is configured, not by asking it nicely.
 */
/**
 * A question to a comparison's agent. It reads snapshots of two to four
 * experiments and answers; it is given read tools and nothing else, so it
 * cannot run anything or change any of them.
 */
export interface ComparisonSpec {
  comparisonId: string;
  /** The comparison's folder of snapshots, where the agent starts. */
  cwd: string;
  prompt: string;
  /** References attached to this question, copied read-only inside `cwd`. */
  references?: ReadonlyArray<{ name: string; path: string }>;
  /** The comparison's own session, to continue; null for its first question. */
  resumeSessionId: string | null;
  model: string | null;
  effort: string | null;
  agentEnv: Record<string, string> | null;
  signal: AbortSignal;
}

export interface Comparer {
  compare(spec: ComparisonSpec): AsyncIterable<RunEvent>;
}

export interface TextDrafter {
  draft(request: DraftRequest): Promise<string>;
}

export interface DraftRequest {
  /** What kind of text to write, as the system prompt. */
  instructions: string;
  /** Everything to write it from. */
  input: string;
  model: string | null;
  agentEnv: Record<string, string> | null;
  signal: AbortSignal;
}
