import type { AgentQuestion } from '@bonsai/shared';

/**
 * D14e: agent invocation sits behind one interface, so swapping the model or
 * the harness is cheap.
 *
 * M2 ships FakeRunner as the only implementation, which is deliberate: the git
 * layer is the subtlest part of the product and testing it without agent
 * latency or cost is much faster. M3 adds ClaudeSdkRunner and changes nothing
 * else -- the pipeline below this interface already commits, branches and walks
 * lineage exactly as it will in production.
 */

export interface RunSpec {
  runId: string;
  nodeId: string;
  /** The node's worktree. The isolation boundary (D17). */
  cwd: string;
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
  signal: AbortSignal;
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
  | { type: 'tool'; name: string; detail: string }
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
