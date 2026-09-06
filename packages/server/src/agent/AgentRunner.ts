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
  /** D16: fork the parent's session rather than resuming it. Unused until M3. */
  resumeSessionId: string | null;
  /** D18: read-only for frozen nodes. Enforced from M3. */
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
