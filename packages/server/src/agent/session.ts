import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BackgroundJob, RunActivity } from '@bonsai/shared';

/**
 * The agent's input, held open until the run decides it is over (D43).
 *
 * A run used to hand the SDK its prompt as a plain string. The harness then
 * treats the end of the agent's first turn as the end of the session, and
 * about five seconds later it STOPS any command the agent left running in the
 * background -- verified against the real SDK. That is how an experiment's
 * `uv sync` and batch run were cut off while Bonsai reported the run Finished.
 *
 * Given a stream instead, the session stays alive between turns: a background
 * command runs to completion, and the harness wakes the agent to deal with its
 * output. Closing this stream is what ends the session.
 */
export class Inbox implements AsyncIterable<SDKUserMessage> {
  private readonly pending: SDKUserMessage[] = [];
  private closed = false;
  private wake: (() => void) | null = null;

  send(text: string): void {
    if (this.closed) return;
    this.pending.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    this.notify();
  }

  /** Nothing more will be said. The harness finishes what it is doing, then exits. */
  close(): void {
    this.closed = true;
    this.notify();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

/**
 * How long to wait for the agent to be woken once its background work has
 * ended. The harness wakes it within a second or two in practice; this only
 * matters if it never does, where waiting for ever would hold the run open
 * with nothing left to wait for.
 */
export const WAKE_GRACE_MS = 60_000;

/** One entry of the SDK's `background_tasks_changed` payload. */
export interface HarnessTask {
  task_id: string;
  description: string;
  ambient?: boolean;
}

/**
 * What the session is doing, and whether a finished turn means a finished run.
 *
 * Kept apart from the SDK loop so the rule can be tested without a model:
 *
 *   a turn ends and nothing is running      -> the run is over;
 *   a turn ends and background work is live -> wait. The harness wakes the
 *                                              agent when that work settles,
 *                                              and the next turn decides again;
 *   Finish now                              -> over at the end of this turn,
 *                                              whatever is still running.
 *
 * The live set is the harness's own level signal, replaced wholesale on every
 * change as its documentation asks, rather than rebuilt from start and end
 * events -- a missed end event would otherwise hold a run open for ever.
 * Ambient tasks (the harness's own watchers) are not work anyone started.
 */
export class SessionActivity {
  private state: RunActivity['state'] = 'working';
  private readonly jobs = new Map<string, BackgroundJob>();
  /** Main-thread tool calls in progress, oldest first. */
  private readonly tools = new Map<string, NonNullable<RunActivity['tool']>>();
  /** Between the end of one turn and the start of the next. */
  private idle = false;
  private finishing = false;
  private wakeTimer: NodeJS.Timeout | null = null;
  private reported = '';

  constructor(
    private readonly report: (activity: RunActivity) => void,
    /** Ends the session. Called only when the harness never wakes the agent. */
    private readonly end: () => void,
    private readonly clock: () => Date = () => new Date(),
    private readonly wakeGraceMs = WAKE_GRACE_MS,
  ) {}

  /** Tracked jobs still running, for Stop and Finish now to stop. */
  liveJobIds(): string[] {
    return [...this.jobs.keys()];
  }

  isFinishing(): boolean {
    return this.finishing;
  }

  /** The agent is taking a turn: something it said, or a tool it called, arrived. */
  turnStarted(): void {
    this.idle = false;
    this.clearWake();
    this.state = 'working';
    this.publish();
  }

  /**
   * Thinking is under way. Only trusted as the start of a turn while a wake is
   * expected, because background subagents think too, and their thinking is
   * not the main agent taking a turn.
   */
  thinking(): void {
    if (this.wakeTimer !== null) this.turnStarted();
  }

  toolStarted(id: string, name: string, detail: string): void {
    this.tools.set(id, { name, detail, startedAt: this.clock().toISOString() });
    this.publish();
  }

  toolFinished(id: string): void {
    if (this.tools.delete(id)) this.publish();
  }

  jobsChanged(tasks: readonly HarnessTask[]): void {
    const hadJobs = this.jobs.size > 0;
    const next = new Map<string, BackgroundJob>();
    for (const task of tasks) {
      if (task.ambient === true) continue;
      next.set(
        task.task_id,
        this.jobs.get(task.task_id) ?? {
          id: task.task_id,
          description: task.description,
          tracked: true,
          startedAt: this.clock().toISOString(),
        },
      );
    }
    this.jobs.clear();
    for (const [id, job] of next) this.jobs.set(id, job);

    // The last job ended while the agent was idle. The harness is about to
    // wake it with the result; until then it is working, not waiting.
    if (this.idle && hadJobs && this.jobs.size === 0 && !this.finishing) {
      this.state = 'working';
      this.armWake();
    }
    this.publish();
  }

  /**
   * A turn has ended. True when the run is over and the session should close.
   *
   * `queued` is the harness's count of messages already waiting to be sent,
   * each of which means another turn follows without anything from here.
   */
  turnEnded(queued: number): boolean {
    this.tools.clear();
    this.idle = queued === 0;
    let over: boolean;
    if (this.finishing) over = true;
    else if (queued > 0) {
      this.state = 'working';
      over = false;
    } else if (this.jobs.size === 0) over = true;
    else {
      this.state = 'waiting';
      over = false;
    }
    this.publish();
    return over;
  }

  /** Finish now: whatever is still running, the end of this turn is the end of the run. */
  finish(): void {
    this.finishing = true;
    this.clearWake();
  }

  dispose(): void {
    this.clearWake();
  }

  private armWake(): void {
    this.clearWake();
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      if (this.idle && this.jobs.size === 0) this.end();
    }, this.wakeGraceMs);
    this.wakeTimer.unref();
  }

  private clearWake(): void {
    if (this.wakeTimer === null) return;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
  }

  private publish(): void {
    const tools = [...this.tools.values()];
    const activity: RunActivity = {
      state: this.state,
      tool: this.state === 'waiting' ? null : (tools.at(-1) ?? null),
      background: [...this.jobs.values()],
    };
    const key = JSON.stringify(activity);
    if (key === this.reported) return;
    this.reported = key;
    this.report(activity);
  }
}
