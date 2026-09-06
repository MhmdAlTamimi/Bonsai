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
  model: string | null;
  permissionMode: string;
  signal: AbortSignal;
}

export type RunEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; detail: string }
  | { type: 'session'; sessionId: string }
  | { type: 'done'; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: 'error'; error: string };

export interface AgentRunner {
  run(spec: RunSpec): AsyncIterable<RunEvent>;
}
