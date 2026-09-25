import type { AgentQuestion, BackgroundJob, RunActivity, ToolResultContent } from '@bonsai/shared';

/** Runner boundary shared by the real SDK adapter and deterministic test runner. */
export interface RunSpec {
  runId: string;
  nodeId: string;
  /** The agent's working directory inside the experiment checkout; not a sandbox. */
  cwd: string;
  /** Repository-root notes path, independent of the selected working subdirectory. */
  contextPath?: string;
  parentContextPath?: string | null;
  prompt: string;
  /**
   * D16: the session to continue from, or null for a node with no ancestry to
   * inherit (master's first run).
   *
   * Paired with `forkSession`, which says WHICH conversation this is:
   *   fork  -- this is the parent's session, and we want a copy of it
   *   resume -- this is the node's own session, and we are adding to it
   */
  resumeSessionId: string | null;
  /** True when resumeSessionId belongs to the PARENT and must not be advanced. */
  forkSession: boolean;
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
  | { type: 'tool'; name: string; detail: string; id?: string; parentToolUseId?: string }
  /** What a tool produced: a command's output, or an edit's changed lines. */
  | { type: 'tool_result'; result: ToolResultContent }
  | { type: 'session'; sessionId: string }
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
  | { type: 'error'; error: string };

export interface AgentRunner {
  run(spec: RunSpec): AsyncIterable<RunEvent>;
}
