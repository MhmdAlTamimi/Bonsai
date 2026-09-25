import { resolveRunContext } from './runContext.js';
import { allocateNodeWorktree } from '../projects.js';
import { OperationConflict } from '../domain/errors.js';
import { resolveRunSettings } from './runSettings.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  CONCURRENCY,
  recoveryCause,
  type BackgroundJob,
  type NodeStatus,
  type RunActivity,
} from '@bonsai/shared';

import type { NodeRow, RunEnd, RunTotals, Store } from '../db/store.js';
import { workDirIn } from '../db/rows.js';
import { assertGitState, expectedGitState } from '../git/ownership.js';

/** A plain record for when the agent skipped writing one (D22). */
function contextFallback(displayName: string, prompt: string): string {
  return [
    `# ${displayName}`,
    '',
    '## What was asked',
    '',
    prompt.trim(),
    '',
    '_The agent did not leave its own notes for this run, so Bonsai recorded the request._',
    '',
  ].join('\n');
}

/** Just the parts of Settings a run needs, so tests need not build the whole thing. */
export interface SettingsSource {
  model(): string | null;
  effort(): string | null;
  agentEnv(): Record<string, string> | null;
  /** How many runs may be in flight at once. Absent means the shared default. */
  maxConcurrentRuns?(): number;
}
import type { EventBus } from '../api/events.js';
import { silentLogger, type Logger } from '../log.js';
import type {
  AgentRunner,
  ChoiceDecision,
  ChoiceRequest,
  PermissionDecision,
  PermissionRequest,
} from '../agent/AgentRunner.js';
import { commitMessageFor, commitRunOutput } from '../git/commit.js';
import { branchNameFor } from '../git/repo.js';
import { readWorktreeState, resumePrompt } from '../git/recovery.js';
import { runCommand, summarise } from '../exec/command.js';
import { status } from '../git/exec.js';
import { parentSnapshot } from '../git/diff.js';
import { findLeftovers, roots, stopLeftovers } from './leftovers.js';

/**
 * D14d: runs are async jobs. Start returns a job id, progress streams, cancel
 * works, nothing blocks the UI.
 *
 * The job pipeline owns scheduling, permission snapshots, streaming, commits
 * and lineage bookkeeping. SDK details stay behind AgentRunner.
 */
/** What a parked run is told when the node is stopped rather than answered. */
const STOPPED: PermissionDecision = { allow: false, reason: 'the run was stopped' };

/**
 * The question, as the panel and the card will show it.
 *
 * A statement rather than a question mark: the card already carries a `?`
 * glyph and the words "needs you", so "May the agent...?" would be the third
 * time the same screen asked.
 */
function questionText(request: PermissionRequest): string {
  const detail = request.detail.trim();
  return detail === ''
    ? `The agent wants to use ${request.toolName}.`
    : `The agent wants to use ${request.toolName}: ${detail}`;
}

/** A run that has been asked for and is waiting for a slot. */
interface Queued {
  runId: string;
  nodeId: string;
  projectId: string;
  prompt: string;
  readOnly: boolean;
  controller: AbortController;
}

/**
 * A run with an agent, and what the interface can see and do while it lasts.
 *
 * Stop and Finish now are two controllers because they are two different
 * endings: Stop cancels the run and commits nothing, Finish now stops waiting
 * for background work and lets the run end -- and commit -- the ordinary way.
 */
interface LiveRun {
  runId: string;
  projectId: string;
  controller: AbortController;
  finish: AbortController;
  activity: RunActivity | null;
  /** Tracked jobs that were live when Stop or Finish now was pressed. */
  stoppedTracked: number;
  /** When `run.activity` last went out, and the trailing publish when one is due. */
  publishedAt: number;
  publishTimer: NodeJS.Timeout | null;
}

/** `run.activity` goes out at most this often per run; a long command changes nothing a second. */
const ACTIVITY_INTERVAL_MS = 1_000;

/** A run held on a question, and the one function that lets it go. */
interface Waiter {
  questionId: string;
  /** Which kind of answer releases it, so the wrong kind cannot. */
  kind: 'permission' | 'choice';
  settle: (outcome: PermissionDecision | ChoiceDecision, resume: boolean) => void;
}

/** What a parked question is told when the node is stopped rather than answered. */
const STOPPED_CHOICE: ChoiceDecision = { answered: false, reason: 'the run was stopped' };

/**
 * Told to the agent when the user leaves a question to it (D42).
 *
 * It has to say what to do, not only that nobody answered: the SDK hands this
 * back as the tool's result, and "decide, and say what you assumed" is the
 * difference between an agent that carries on visibly and one that guesses in
 * silence -- or, as before, one that announces it is waiting and stops.
 */
export const LEFT_TO_AGENT =
  'The user chose not to answer and left this decision to you. Make a reasonable choice, ' +
  'carry on, and say clearly in your reply what you decided and why.';

/** Tracked jobs in a run's activity: what Stop or Finish now is about to stop. */
function trackedJobs(activity: RunActivity | null): number {
  return activity?.background.filter((job) => job.tracked).length ?? 0;
}

/** A process's command line, short enough for a card. */
function describeProcess(command: string): string {
  const trimmed = command.trim() || 'a process';
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

/**
 * A run's detached processes, as the jobs the interface shows: one per piece of
 * work rather than per process. Keyed by pid, which is stable for as long as
 * the process lives -- which is as long as it is shown.
 */
async function detachedJobs(runId: string): Promise<BackgroundJob[]> {
  return roots(await findLeftovers(runId)).map((p) => ({
    id: `pid:${p.pid}`,
    description: describeProcess(p.command),
    tracked: false,
    startedAt: new Date().toISOString(),
  }));
}

/** The question as the card and the transcript show it: the questions, in order. */
function choiceText(request: ChoiceRequest): string {
  return request.questions.map((q) => q.question).join(' · ');
}

export class RunJobs {
  private readonly running = new Map<string, LiveRun>();
  /**
   * Runs waiting for a slot, oldest first.
   *
   * A queued run already has its row, its abort controller and its node marked
   * `running`, because from the user's side it IS running -- they asked for it
   * and it is going to happen. What it does not have is an agent. Making it a
   * sixth node status was the obvious alternative and is wrong: there are
   * exactly five, the schema constrains them, and the difference is invisible
   * to everything except the card's queue badge.
   */
  private readonly queue: Queued[] = [];

  /**
   * Runs parked on a question, by node id. One at a time per node: a node has
   * at most one run, and a run stops dead until its question is answered.
   *
   * A parked run still holds its concurrency slot, because it still holds an
   * agent process and a live session -- there is nothing to release. That is
   * visible (the card says `needs you`) and escapable (stopping the node
   * resolves the question as a refusal and frees the slot), which is the
   * honest version of a problem the alternatives only hide.
   */
  private readonly waiting = new Map<string, Waiter>();

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly runner: AgentRunner,
    private readonly settings?: SettingsSource,
    private readonly log: Logger = silentLogger,
    private readonly connection?: { recordFailure(message: string): void },
  ) {}

  private readonly retiring = new Set<string>();
  /**
   * Set once the app starts shutting down, so the runs it cancels on the way
   * out are recorded as the app closing rather than as the user stopping them.
   */
  private closing = false;
  isRetiring(nodeId: string): boolean {
    return this.retiring.has(nodeId);
  }
  /** Keep files and rows intact until every affected job has unwound. */
  async withStoppedNodes<T>(ids: readonly string[], remove: () => Promise<T>): Promise<T> {
    if (ids.some((id) => this.retiring.has(id)))
      throw new OperationConflict('Deletion is already in progress.');
    for (const id of ids) this.retiring.add(id);
    try {
      for (const id of ids) this.cancel(id);
      const deadline = Date.now() + 10_000;
      while (ids.some((id) => this.isRunning(id))) {
        if (Date.now() >= deadline)
          throw new OperationConflict(
            'The agent is still stopping. Work is kept; retry deletion after it stops.',
          );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return await remove();
    } finally {
      for (const id of ids) this.retiring.delete(id);
    }
  }

  activeRunId(nodeId: string): string | null {
    return (
      this.running.get(nodeId)?.runId ??
      this.queue.find((job) => job.nodeId === nodeId)?.runId ??
      null
    );
  }

  isRunning(nodeId: string): boolean {
    return this.running.has(nodeId) || this.queue.some((q) => q.nodeId === nodeId);
  }

  /**
   * 1-based place in the queue, or null when this node is not waiting.
   *
   * Read by the router when it builds a tree for the interface. The store does
   * not know about jobs and should not: queue position is a fact about this
   * process, not about the tree.
   */
  queuePosition(nodeId: string): number | null {
    const index = this.queue.findIndex((q) => q.nodeId === nodeId);
    return index === -1 ? null : index + 1;
  }

  queuedCount(): number {
    return this.queue.length;
  }

  /**
   * Cancellation exists from day one, not as a retrofit.
   *
   * Two cases now. An in-flight run is aborted and unwinds through the normal
   * path. A QUEUED run has no agent to abort, so it is dropped from the queue
   * and closed out here -- otherwise stopping something that had not started
   * yet would leave a node stuck in `running` for ever.
   */
  cancel(nodeId: string): boolean {
    const live = this.running.get(nodeId);
    if (live !== undefined) {
      if (!live.controller.signal.aborted) live.stoppedTracked = trackedJobs(live.activity);
      live.controller.abort();
      return true;
    }

    const index = this.queue.findIndex((q) => q.nodeId === nodeId);
    if (index === -1) return false;
    const [dropped] = this.queue.splice(index, 1);
    if (dropped === undefined) return false;

    this.log.info('run.cancelled', { runId: dropped.runId, nodeId, queued: true });
    this.store.finishRun(dropped.runId, this.stopped(), {
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    this.setStatus(nodeId, this.store.getNode(nodeId)?.head_commit === null ? 'new' : 'ready');
    this.bus.publish(dropped.projectId, {
      type: 'tree.updated',
      projectId: dropped.projectId,
    });
    return true;
  }

  /**
   * D43: Finish now. Stop waiting for the background work the agent started,
   * stop that work, and end the run normally, so what it produced is committed.
   *
   * False when there is nothing to finish: no run with an agent (a queued run
   * has started nothing -- Stop drops it), or a run parked on a question, which
   * cannot end its turn until the question is answered or the run is stopped.
   */
  finish(nodeId: string): boolean {
    const live = this.running.get(nodeId);
    if (live === undefined || this.waiting.has(nodeId)) return false;
    if (live.finish.signal.aborted || live.controller.signal.aborted) return true;

    const jobs = live.activity?.background ?? [];
    this.store.appendMessage({
      nodeId,
      runId: live.runId,
      role: 'system',
      kind: 'text',
      content:
        jobs.length === 0
          ? 'Finish now: the run ends when the agent’s current turn does.'
          : `Finish now: stopping ${jobs.length === 1 ? 'the background job' : `${jobs.length} background jobs`} ` +
            `(${jobs.map((job) => job.description).join(' · ')}) and ending the run.`,
    });
    this.log.info('run.finish_now', { runId: live.runId, nodeId, jobs: jobs.length });
    live.stoppedTracked = trackedJobs(live.activity);
    live.finish.abort();
    return true;
  }

  /** What a running node is doing right now, or null. Read by the router, like `queuePosition`. */
  activity(nodeId: string): RunActivity | null {
    return this.running.get(nodeId)?.activity ?? null;
  }

  /**
   * D34: the user's answer to a question the agent stopped on.
   *
   * Returns false when there is nothing waiting on this question -- it was
   * already answered, or the app restarted and the run it belonged to died
   * with the process. Neither is an error worth a red banner; the tree will
   * already be showing the node as interrupted.
   */
  answer(questionId: string, decision: PermissionDecision): boolean {
    return this.release(questionId, 'permission', decision);
  }

  /**
   * D42: the user's answers to questions the agent asked, keyed by question.
   *
   * Same guarantees as `answer`: false when nothing is waiting on this exact
   * question any more, so a second window cannot resume a run twice.
   */
  answerChoices(questionId: string, answers: Record<string, string>): boolean {
    return this.release(questionId, 'choice', { answered: true, answers });
  }

  /** D42: answer nothing, and let the agent decide -- and say what it decided. */
  leaveToAgent(questionId: string): boolean {
    return this.release(questionId, 'choice', { answered: false, reason: LEFT_TO_AGENT });
  }

  private release(
    questionId: string,
    kind: Waiter['kind'],
    outcome: PermissionDecision | ChoiceDecision,
  ): boolean {
    const question = this.store.getQuestion(questionId);
    if (question === undefined) return false;
    const waiter = this.waiting.get(question.node_id);
    if (waiter?.questionId !== questionId || waiter.kind !== kind) return false;
    waiter.settle(outcome, true);
    return true;
  }

  /** The question a node is parked on, if it is. */
  pendingAsk(nodeId: string): string | null {
    return this.waiting.get(nodeId)?.questionId ?? null;
  }

  cancelAll(): void {
    // The queue first: draining it into aborts would start each run only to
    // stop it, which costs a subprocess launch apiece.
    for (const q of [...this.queue]) this.cancel(q.nodeId);
    for (const live of this.running.values()) live.controller.abort();
  }

  /** How many runs are in flight. Shutdown and tests wait on this. */
  activeCount(): number {
    return this.running.size;
  }

  /**
   * Cancels everything and waits for it to unwind.
   *
   * A run outlives its cancel signal: the runner stops, but the pipeline still
   * has to finish writing the run row and deciding whether to commit. Closing
   * the database before that lands throws inside a job nobody is awaiting, and
   * an unawaited throw in a `void`-ed promise is an unhandled rejection.
   */
  async drain(timeoutMs = 5000): Promise<void> {
    this.closing = true;
    this.cancelAll();
    const deadline = Date.now() + timeoutMs;
    while ((this.running.size > 0 || this.queue.length > 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * §6.6: resume an interrupted run.
   *
   * The worktree is read FIRST and injected into the prompt, because the agent
   * knows what it intended rather than what landed. Everything else -- session
   * resume, commit-or-not, freeze -- is the ordinary run path.
   */
  async startResume(nodeId: string): Promise<{ runId: string }> {
    const node = this.store.getNode(nodeId);
    if (node === undefined) throw new Error('no such node');

    const state =
      node.worktree_allocated === 0
        ? { changed: [], untracked: [], patch: '' }
        : await readWorktreeState(node.worktree_path);
    const original = this.store.lastUserPrompt(nodeId) ?? node.description;
    const last = this.store.listRuns(nodeId).at(-1);
    return this.start(
      nodeId,
      resumePrompt(state, original, recoveryCause(last), last?.error ?? null),
    );
  }

  start(nodeId: string, prompt: string): { runId: string } {
    const node = this.store.getNode(nodeId);
    if (node === undefined) throw new Error('no such node');
    if (this.isRetiring(nodeId)) throw new OperationConflict('This experiment is being deleted.');
    if (this.isRunning(nodeId))
      throw new OperationConflict('This experiment is already running or queued.');

    // Children never change authority. Only the user's original checkout is read-only.
    const view = this.store.treeView(node.project_id).find((n) => n.id === nodeId);
    const readOnly = view !== undefined && !view.writable;

    const runId = randomUUID();
    const controller = new AbortController();

    this.store.createRun(runId, nodeId);
    // Lengths, never contents: a log is the artefact most likely to be pasted
    // into a bug report, and the prompt is the user's own words about their
    // own code.
    this.log.info('run.start', {
      runId,
      nodeId,
      projectId: node.project_id,
      promptChars: prompt.length,
      readOnly,
    });
    // Marked running even when it will wait: the user asked for it, it is
    // going to happen, and the only visible difference is a queue badge.
    this.setStatus(nodeId, 'running');

    const job: Queued = {
      runId,
      nodeId,
      projectId: node.project_id,
      prompt,
      readOnly,
      controller,
    };

    if (this.running.size < this.limit()) {
      this.dispatch(job);
    } else {
      this.queue.push(job);
      this.log.info('run.queued', {
        runId,
        nodeId,
        position: this.queue.length,
        limit: this.limit(),
      });
      // No run.started here -- that event clears the live output pane, and a
      // queued run has nothing to show yet. tree.updated is what makes the
      // card render its place in the queue.
      this.bus.publish(node.project_id, { type: 'tree.updated', projectId: node.project_id });
    }

    return { runId };
  }

  private limit(): number {
    return this.settings?.maxConcurrentRuns?.() ?? CONCURRENCY.default;
  }

  /** Starts a job now, and takes the next queued one when it finishes. */
  private dispatch(job: Queued): void {
    const live: LiveRun = {
      runId: job.runId,
      projectId: job.projectId,
      controller: job.controller,
      finish: new AbortController(),
      activity: null,
      stoppedTracked: 0,
      publishedAt: 0,
      publishTimer: null,
    };
    this.running.set(job.nodeId, live);
    this.bus.publish(job.projectId, {
      type: 'run.started',
      nodeId: job.nodeId,
      runId: job.runId,
    });

    void this.execute(job.runId, job.nodeId, job.prompt, job.readOnly, live).finally(() => {
      if (live.publishTimer !== null) clearTimeout(live.publishTimer);
      this.running.delete(job.nodeId);
      this.pump();
    });
  }

  /**
   * Records what a run is doing, and tells the interface -- at most once a
   * second, with the latest state always sent last, so nothing is lost but a
   * burst of tool calls is not a burst of events.
   */
  private reportActivity(nodeId: string, live: LiveRun, activity: RunActivity): void {
    const was = live.activity?.state;
    live.activity = activity;
    if (activity.state === 'waiting' && was !== 'waiting') {
      // Counts, not descriptions: a description is the agent's words about
      // the user's code, and logs are what get pasted into bug reports.
      this.log.info('run.waiting', {
        runId: live.runId,
        nodeId,
        jobs: activity.background.length,
        untracked: activity.background.filter((job) => !job.tracked).length,
      });
    }
    if (live.publishTimer !== null) return;
    const due = live.publishedAt + ACTIVITY_INTERVAL_MS - Date.now();
    if (due <= 0) {
      this.publishActivity(nodeId, live);
      return;
    }
    live.publishTimer = setTimeout(() => {
      live.publishTimer = null;
      this.publishActivity(nodeId, live);
    }, due);
  }

  private publishActivity(nodeId: string, live: LiveRun): void {
    if (live.activity === null || this.running.get(nodeId) !== live) return;
    live.publishedAt = Date.now();
    this.bus.publish(live.projectId, {
      type: 'run.activity',
      nodeId,
      runId: live.runId,
      activity: live.activity,
    });
  }

  /**
   * Fills every free slot.
   *
   * A loop rather than a single take, because the limit can be raised while
   * runs are queued -- and because cancelling three at once frees three slots
   * in the same tick.
   */
  private pump(): void {
    while (this.running.size < this.limit()) {
      const next = this.queue.shift();
      if (next === undefined) return;
      // It may have been cancelled while queued; cancel() removes it from the
      // queue, so reaching here means it is still wanted, but the controller
      // is checked anyway rather than trusted.
      if (next.controller.signal.aborted) continue;
      this.bus.publish(next.projectId, { type: 'tree.updated', projectId: next.projectId });
      this.dispatch(next);
    }
  }

  /**
   * Runs the project's setup command once, in this node's worktree.
   *
   * `git worktree add` checks out tracked files only, so a new node has no
   * node_modules and no virtualenv. Without this the agent lands somewhere the
   * tests cannot run, and the success criteria from 2.1 report "I wrote the
   * code but could not check anything" -- which is the feature failing quietly
   * rather than loudly.
   *
   * Here rather than at node creation because it is slow: `npm install` on a
   * cold cache takes minutes, and blocking the create response for that would
   * freeze the canvas at the moment the user is watching it appear. Here it is
   * asynchronous, cancellable, streamed to the panel and logged.
   *
   * A FAILURE DOES NOT STOP THE RUN. The agent is told what happened instead,
   * because a setup command that fails for a reason the agent can fix -- a
   * missing lockfile, a wrong Node version -- is exactly the thing it should
   * be given a chance at, and refusing to start would leave the user with a
   * node that can do nothing at all.
   */
  private async ensureSetup(
    node: NodeRow,
    project: { setup_command: string | null; id: string; work_dir: string | null },
    runId: string,
    live: LiveRun,
  ): Promise<void> {
    const command = project.setup_command;
    const controller = live.controller;
    if (command === null || command.trim() === '') return;
    // Once per node. Recorded in the database so a restart mid-install does
    // not mean running it again on every message from then on.
    if (node.setup_ran_at !== null) return;
    if (controller.signal.aborted) return;

    // A cold `npm install` takes minutes, and should read as running, not stuck.
    this.reportActivity(node.id, live, {
      state: 'working',
      tool: { name: 'Setup', detail: command, startedAt: new Date().toISOString() },
      background: [],
    });

    this.store.appendMessage({
      nodeId: node.id,
      runId,
      role: 'system',
      kind: 'text',
      content: `Setting up this node: ${command}`,
    });
    this.bus.publish(node.project_id, {
      type: 'run.delta',
      nodeId: node.id,
      runId,
      seq: 0,
      text: `setup: ${command}`,
    });

    const result = await runCommand({
      command,
      // The agent's working directory, not the worktree root: `npm install`
      // for a project opened at `services/api` belongs in `services/api`.
      cwd: workDirIn(node.worktree_path, project.work_dir),
      signal: controller.signal,
      env: { BONSAI_RUN_ID: runId },
      onOutput: (chunk) => {
        this.bus.publish(node.project_id, {
          type: 'run.delta',
          nodeId: node.id,
          runId,
          seq: 0,
          text: chunk,
        });
      },
    });

    this.reportActivity(node.id, live, { state: 'working', tool: null, background: [] });
    this.log.info('node.setup', {
      nodeId: node.id,
      projectId: node.project_id,
      ok: result.ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    });

    this.store.appendMessage({
      nodeId: node.id,
      runId,
      role: 'system',
      kind: 'text',
      content: result.ok
        ? summarise(result)
        : `${summarise(result)}\n\n${result.stderr || result.stdout}`.slice(0, 4000),
    });

    /**
     * Setup output that git can see is a problem worth naming.
     *
     * Bonsai decides whether a run committed by looking at the worktree, so a
     * setup command that leaves a file git does not ignore makes the node
     * commit even when the agent changed nothing -- quietly turning a
     * conversation-only node into one with a branch, which is the emergent
     * model breaking rather than bending.
     *
     * Real setup commands write to gitignored places (node_modules, .venv) and
     * never hit this. When one does, it is said out loud rather than fixed:
     * the fix would be editing the user's .gitignore, which is theirs.
     */
    const leftBehind = (await status(node.worktree_path)).filter((e) => e.path !== 'CONTEXT.md');
    if (leftBehind.length > 0) {
      const names = leftBehind
        .slice(0, 8)
        .map((e) => e.path)
        .join(', ');
      this.store.appendMessage({
        nodeId: node.id,
        runId,
        role: 'system',
        kind: 'text',
        content:
          `Setup left ${leftBehind.length} file(s) git does not ignore (${names}). They will be ` +
          `part of this node's first commit. If that is not what you want, add them to ` +
          `.gitignore in your project.`,
      });
    }

    // Marked on command failure (but not cancellation): retrying a broken install on every message would
    // burn minutes each time and produce the same error.
    if (!controller.signal.aborted) this.store.markSetupRan(node.id);
  }

  private async execute(
    runId: string,
    nodeId: string,
    prompt: string,
    readOnly: boolean,
    live: LiveRun,
  ): Promise<void> {
    const controller = live.controller;
    // Fetched defensively rather than with `!`: these two lines sit outside the
    // try below, so a throw here would escape into an unhandled rejection and
    // take the process down instead of failing the run. A node deleted between
    // start and execute is unlikely but not impossible -- delete cancels a
    // running node rather than blocking on it.
    const node = this.store.getNode(nodeId);
    const project = node === undefined ? undefined : this.store.getProject(node.project_id);
    if (node === undefined || project === undefined) {
      this.store.finishRun(
        runId,
        {
          status: 'failed',
          reason: 'failed',
          error: 'the node was removed before its run started',
        },
        { cost: 0, inputTokens: 0, outputTokens: 0 },
      );
      return;
    }

    let seq = 0;
    let cost = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let model: string | null = null;
    let apiKeySource: string | null = null;
    /**
     * The tool names the agent was actually offered, and how many calls it
     * made. The runner has always yielded the first of these and the pipeline
     * dropped it, which is unfortunate: "which tools did it have" is the exact
     * question behind "it said it edited files but committed nothing", a bug
     * this project has already hit once.
     */
    let toolsOffered: string[] | null = null;
    let toolCalls = 0;
    /** The last message the agent wrote; kept only if the run finishes (see `session_position`). */
    let position: string | null = null;
    const startedAt = Date.now();

    this.store.appendMessage({ nodeId, runId, role: 'user', kind: 'text', content: prompt });

    try {
      resolveRunContext(this.store, node, runId);
      if (controller.signal.aborted) throw new Error('Cancelled before allocation.');
      const seeded = await allocateNodeWorktree(this.store, node);
      for (const outcome of seeded)
        if (!outcome.copied)
          this.store.appendMessage({
            nodeId,
            runId,
            role: 'system',
            kind: 'text',
            content: `Could not copy ${outcome.path}: ${outcome.reason ?? 'unknown reason'}`,
          });
      const expectedState = readOnly ? null : await expectedGitState(project.repo_path, node);
      if (expectedState) await assertGitState(node.worktree_path, expectedState);
      // Setup mutates files and obeys the same ownership boundary as agent writes.
      if (!readOnly) await this.ensureSetup(node, project, runId, live);
      if (expectedState) await assertGitState(node.worktree_path, expectedState);
      if (controller.signal.aborted) {
        // Stopped before the agent started: still a cancellation, and the log
        // has to say so -- otherwise a run stopped during setup or the git
        // checks leaves no trace of why it ended.
        this.log.info('run.cancelled', {
          runId,
          nodeId,
          durationMs: Date.now() - startedAt,
          beforeAgent: true,
        });
        await this.endLeftovers(runId, nodeId, node.project_id);
        this.finishRun(runId, nodeId, this.stopped(), { cost, inputTokens, outputTokens });
        return;
      }
      // Node override, then the project's default, then the app's.
      const effective = resolveRunSettings(node, project, this.settings);
      const permissionMode = effective.permissionMode;

      for await (const event of this.runner.run({
        runId,
        nodeId,
        /**
         * D37: the worktree remains the experiment checkout, and git still sees
         * the whole repository -- this is only where the agent stands inside
         * it, the way an editor opens a folder. '' means the worktree root,
         * which is every project that did not choose a subdirectory.
         */
        cwd: workDirIn(node.worktree_path, project.work_dir),
        contextPath: join(node.worktree_path, 'CONTEXT.md'),
        prompt,
        // Always the node's own session. A child's was copied from its parent
        // when it was created (jobs/conversation.ts), never here.
        resumeSessionId: node.session_id,
        readOnly,
        successCriteria: node.success_criteria,
        verificationHint: node.verification_hint,
        // Node override, then the project's default, then the app setting.
        model: effective.model,
        effort: effective.effort,
        permissionMode,
        agentEnv: this.settings?.agentEnv() ?? null,
        /**
         * D34, and the only thing that makes `needs_you` reachable.
         *
         * Offered only under `default`, the mode that means "ask me". Under
         * `acceptEdits` the user has said they do not want to be asked, and a
         * read-only run has nothing to ask about -- its tools cannot change
         * anything, so every question would be one it already knows the answer
         * to.
         */
        ask:
          permissionMode === 'default' && !readOnly
            ? (request): Promise<PermissionDecision> =>
                this.askUser(node, runId, request, controller)
            : null,
        /**
         * D42: in every mode, read-only runs included.
         *
         * `ask` above is about whether Bonsai checks before the agent acts, so
         * the mode decides it. This is the agent asking the user something,
         * which is not an action to approve -- and when it was tied to the
         * mode, the question vanished and the run ended claiming to wait.
         */
        askChoices: (request): Promise<ChoiceDecision> =>
          this.askChoices(node, runId, request, controller),
        signal: controller.signal,
        finishNow: live.finish.signal,
        onActivity: (activity) => this.reportActivity(nodeId, live, activity),
        backgroundLeftovers: () => detachedJobs(runId),
      })) {
        switch (event.type) {
          case 'session':
            this.store.setSessionId(nodeId, event.sessionId);
            break;
          case 'position':
            position = event.messageId;
            break;
          case 'text':
            seq += 1;
            this.store.appendMessage({
              nodeId,
              runId,
              role: 'assistant',
              kind: 'text',
              content: event.text,
            });
            this.bus.publish(node.project_id, {
              type: 'run.delta',
              nodeId,
              runId,
              seq,
              text: event.text,
            });
            break;
          case 'tool': {
            toolCalls += 1;
            seq += 1;
            const tool = {
              name: event.name,
              ...(event.parentToolUseId === undefined
                ? {}
                : { parentToolUseId: event.parentToolUseId }),
              detail: event.detail,
              ...(event.id === undefined ? {} : { id: event.id }),
            };
            this.store.appendMessage({
              nodeId,
              runId,
              role: 'assistant',
              kind: 'tool_use',
              content: tool,
            });
            this.bus.publish(node.project_id, {
              type: 'run.delta',
              nodeId,
              runId,
              seq,
              text: `${event.name}: ${event.detail}`,
              tool,
            });
            break;
          }
          /**
           * What the call produced, as its own message rather than an edit of
           * the call's row: messages are append-only, and the conversation
           * pairs the two by the tool's id when it draws the block.
           */
          case 'tool_result':
            seq += 1;
            this.store.appendMessage({
              nodeId,
              runId,
              role: 'assistant',
              kind: 'tool_result',
              content: event.result,
            });
            this.bus.publish(node.project_id, {
              type: 'run.delta',
              nodeId,
              runId,
              seq,
              text: '',
              toolResult: event.result,
            });
            break;
          case 'model':
            model = event.model;
            apiKeySource = event.apiKeySource ?? null;
            toolsOffered = event.tools ?? toolsOffered;
            break;
          case 'done':
            // Assigned, never accumulated: total_cost_usd is documented as the
            // running total for the whole query() call, so summing results
            // across turns would count the same tokens repeatedly.
            cost = event.costUsd;
            inputTokens = event.inputTokens;
            outputTokens = event.outputTokens;
            cacheReadTokens = event.cacheReadTokens ?? 0;
            cacheCreationTokens = event.cacheCreationTokens ?? 0;
            model = event.model ?? model;
            break;
          case 'error':
            throw new Error(event.error);
        }
      }

      if (expectedState) await assertGitState(node.worktree_path, expectedState);

      // Before anything is committed, so nothing is still writing into it.
      const detachedStopped = await this.endLeftovers(runId, nodeId, node.project_id);
      const stoppedBackground = live.stoppedTracked + detachedStopped;

      if (controller.signal.aborted) {
        this.log.info('run.cancelled', {
          runId,
          nodeId,
          durationMs: Date.now() - startedAt,
          toolCalls,
          costUsd: cost,
        });
        this.finishRun(runId, nodeId, this.stopped(), {
          cost,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          model,
          apiKeySource,
          toolsOffered,
          toolCalls,
          durationMs: Date.now() - startedAt,
          stoppedBackground,
        });
        return;
      }

      /**
       * The agent touched files; the app touches git (D28) -- unless the run
       * was read-only, in which case the app touches nothing either.
       *
       * Skipping the commit here is not an optimisation. A read-only run cannot
       * have caused a change, so anything the worktree contains was already
       * there, and committing it would attribute someone else's work to this
       * run. That is merely untidy for a frozen node inside Bonsai's own
       * directory; for an adopted project's master, whose worktree IS the
       * user's checkout on their own branch, it would mean `git add -A` and a
       * commit over their uncommitted work. Same for the CONTEXT.md revert in
       * the no-change path, which would discard an edit of theirs.
       */
      const outcome = readOnly
        ? {
            committed: false,
            commit: null,
            branch: null,
            changedPaths: [],
            stat: null,
            ownStat: null,
          }
        : await commitRunOutput({
            repoPath: project.repo_path,
            worktreePath: node.worktree_path,
            branchName: node.branch_name ?? branchNameFor(nodeId),
            message: commitMessageFor(node.display_name, node.description),
            fallbackContext: contextFallback(node.display_name, prompt),
            expectedState: expectedState!,
            baseCommit: await this.baseFor(node),
          });

      const commitSha = outcome.commit;

      if (outcome.committed) {
        // D29: always a new commit, never an amend. A node is a branch that may
        // accumulate several commits without changing existing children’s pinned bases.
        this.store.recordCommit(nodeId, outcome.branch!, outcome.commit!);
      }

      this.store.finishRun(
        runId,
        { status: 'done', reason: 'finished', error: null },
        {
          cost,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          model,
          apiKeySource,
          commitSha,
          toolsOffered,
          toolCalls,
          durationMs: Date.now() - startedAt,
          stat: outcome.stat,
          change: outcome.ownStat,
          stoppedBackground,
        },
      );
      // Only a finished run moves where a child's copy of this conversation ends.
      if (position !== null) this.store.setSessionPosition(nodeId, position);
      this.log.info('run.done', {
        runId,
        nodeId,
        projectId: node.project_id,
        model,
        effort: effective.effort,
        apiKeySource,
        readOnly,
        durationMs: Date.now() - startedAt,
        toolCalls,
        toolsOffered: toolsOffered?.length ?? null,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        costUsd: cost,
        committed: outcome.committed,
        changedFiles: outcome.changedPaths.length,
      });
      this.setStatus(nodeId, 'ready');
      this.bus.publish(node.project_id, {
        type: 'run.finished',
        nodeId,
        runId,
        costUsd: cost,
        inputTokens,
        outputTokens,
      });
      this.bus.publish(node.project_id, { type: 'tree.updated', projectId: node.project_id });
    } catch (err) {
      const stoppedBackground =
        live.stoppedTracked +
        (await this.endLeftovers(runId, nodeId, node.project_id).catch((cleanup: unknown) => {
          this.store.appendMessage({
            nodeId,
            runId,
            role: 'system',
            kind: 'text',
            content: `Cleanup incomplete: ${String(cleanup)}`,
          });
          return 0;
        }));
      /**
       * An abort is a cancellation whatever the runner said on its way out.
       *
       * The real runner returns silently once its signal fires, so this path
       * was never exercised by it -- but a runner that reports the abort as an
       * error (the stand-in did) recorded the run as `failed` with the message
       * "cancelled mid-run", which is not what happened. Deciding this from
       * the signal rather than from the message means no runner can mislabel
       * a stop the user asked for.
       */
      if (controller.signal.aborted) {
        this.log.info('run.cancelled', {
          runId,
          nodeId,
          durationMs: Date.now() - startedAt,
          toolCalls,
          costUsd: cost,
        });
        this.finishRun(runId, nodeId, this.stopped(), {
          cost,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          model,
          apiKeySource,
          toolsOffered,
          toolCalls,
          durationMs: Date.now() - startedAt,
          stoppedBackground,
        });
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      this.connection?.recordFailure(message);
      this.log.error('run.failed', {
        runId,
        nodeId,
        projectId: node.project_id,
        model,
        readOnly,
        durationMs: Date.now() - startedAt,
        toolCalls,
        toolsOffered: toolsOffered?.length ?? null,
        costUsd: cost,
        error: message,
      });
      // D31: a failed run is an `interrupted` node plus an error, not a sixth
      // state. The worktree is left dirty on purpose so M4 can resume it.
      this.finishRun(
        runId,
        nodeId,
        { status: 'failed', reason: 'failed', error: message },
        {
          cost,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          model,
          apiKeySource,
          // Especially on a failure: "which tools did it have" is most of the
          // answer to "why did it do that".
          toolsOffered,
          toolCalls,
          durationMs: Date.now() - startedAt,
          stoppedBackground,
        },
      );
      this.bus.publish(node.project_id, { type: 'run.error', nodeId, runId, error: message });
    }
  }

  /**
   * Best-effort teardown of observed processes carrying this run’s marker.
   *
   * A run normally ends only once its detached processes have exited, so this
   * finds nothing. It matters when the run was stopped, finished early, or
   * failed -- and it is what makes Stop mean stop for a `nohup` job the
   * harness never knew about. Said in the transcript when it does anything.
   */
  private async endLeftovers(runId: string, nodeId: string, projectId: string): Promise<number> {
    // No grace to speak of while the app is closing: shutdown waits only a
    // few seconds for runs to unwind, and a leftover is stopped either way.
    const stopped = await stopLeftovers(runId, this.closing ? 300 : 3_000);
    if (stopped.length === 0) return 0;
    this.log.info('run.leftovers_stopped', { runId, nodeId, projectId, processes: stopped.length });
    this.store.appendMessage({
      nodeId,
      runId,
      role: 'system',
      kind: 'text',
      content:
        `Stopped ${stopped.length === 1 ? 'a background process' : `${stopped.length} background processes`} ` +
        `still running when the run ended: ${stopped.map((p) => describeProcess(p.command)).join(' · ')}`,
    });
    return stopped.length;
  }

  /**
   * What this node's change is measured against.
   *
   * A child pins its base when it is created. Master pins nothing, so its
   * change starts at the commit before its first modifying run -- the same
   * range the review screen uses, so the card's count and the review's file
   * list can never disagree.
   */
  private async baseFor(node: NodeRow): Promise<string | null> {
    if (node.base_commit !== null) return node.base_commit;
    const first = this.store.listRuns(node.id).find((run) => run.commitSha !== null);
    return first?.commitSha == null
      ? null
      : await parentSnapshot(node.worktree_path, first.commitSha);
  }

  /** How a cancelled run ended: stopped by the user, or cut off by the app closing (D45). */
  private stopped(): RunEnd {
    return { status: 'cancelled', reason: this.closing ? 'app_closed' : 'stopped', error: null };
  }

  /**
   * Stops the run and asks permission (D34). Resolves when the user answers,
   * or when the node is stopped.
   */
  private askUser(
    node: NodeRow,
    runId: string,
    request: PermissionRequest,
    controller: AbortController,
  ): Promise<PermissionDecision> {
    const text = questionText(request);
    return this.park<PermissionDecision>(node, runId, controller, {
      kind: 'permission',
      text,
      record: {
        request: {
          action: request.toolName,
          target: request.detail,
          details: request.details ?? request.detail,
        },
      },
      transcript: request.details ? `${text}\n\n${request.details}` : text,
      logged: { tool: request.toolName },
      stopped: STOPPED,
      said: (decision) => (decision.allow ? 'Allowed.' : `Refused: ${decision.reason}`),
    });
  }

  /**
   * Stops the run and puts the agent's own question to the user (D42).
   * Resolves with the answers, with "left to the agent", or when stopped.
   */
  private askChoices(
    node: NodeRow,
    runId: string,
    request: ChoiceRequest,
    controller: AbortController,
  ): Promise<ChoiceDecision> {
    return this.park<ChoiceDecision>(node, runId, controller, {
      kind: 'choice',
      text: choiceText(request),
      record: { questions: request.questions },
      /**
       * The options go into the transcript as well as the question, because
       * "what was it choosing between?" matters as much as what was chosen,
       * and the question row alone is not what anyone reads a week later.
       */
      transcript: request.questions
        .map(
          (q) =>
            `The agent asked: ${q.question}\nOptions: ${q.options.map((o) => o.label).join(' · ')}` +
            (q.multiSelect ? ' (any that apply)' : ''),
        )
        .join('\n\n'),
      logged: { questions: request.questions.length },
      stopped: STOPPED_CHOICE,
      said: (decision) =>
        decision.answered
          ? request.questions
              .map((q) => `${q.question} → ${decision.answers[q.question] ?? ''}`)
              .join('\n')
          : decision.reason === LEFT_TO_AGENT
            ? 'Left the decision to the agent.'
            : `Not answered: ${decision.reason}`,
    });
  }

  /**
   * Parks a run on a question until it is answered or the node is stopped.
   *
   * One implementation for both kinds, because everything that makes parking
   * safe is the same for both, and a second copy is where one of them would
   * lose it:
   *
   *   the question row is written BEFORE the status changes, so no card ever
   *   reads `needs you` with nothing to show;
   *
   *   an answer and an abort can race, and only the first settles it;
   *
   *   stopping the node settles it, or the run hangs on a promise nobody will
   *   resolve and its concurrency slot never comes back;
   *
   *   the status goes back to running BEFORE the promise resolves, so a card
   *   never says `needs you` for a run that is already going again.
   *
   * Both the question and the answer land in the transcript, because "why did
   * this run stall for ten minutes, and what did it decide" should be
   * answerable a week later from the conversation alone.
   */
  private park<T extends PermissionDecision | ChoiceDecision>(
    node: NodeRow,
    runId: string,
    controller: AbortController,
    question: {
      kind: Waiter['kind'];
      text: string;
      record: Pick<Parameters<Store['askQuestion']>[0], 'request' | 'questions'>;
      transcript: string;
      logged: Record<string, unknown>;
      stopped: T;
      said: (outcome: T) => string;
    },
  ): Promise<T> {
    if (controller.signal.aborted) return Promise.resolve(question.stopped);

    const questionId = randomUUID();
    this.store.askQuestion({
      id: questionId,
      runId,
      nodeId: node.id,
      text: question.text,
      ...question.record,
    });
    this.store.appendMessage({
      nodeId: node.id,
      runId,
      role: 'system',
      kind: 'text',
      content: question.transcript,
    });
    this.log.info('run.asked', {
      runId,
      nodeId: node.id,
      projectId: node.project_id,
      kind: question.kind,
      ...question.logged,
    });
    this.setStatus(node.id, 'needs_you');
    this.bus.publish(node.project_id, {
      type: 'run.question',
      nodeId: node.id,
      runId,
      questionId,
      text: question.text,
    });
    this.bus.publish(node.project_id, { type: 'tree.updated', projectId: node.project_id });

    return new Promise<T>((resolve) => {
      let settled = false;
      const settle = (outcome: T, resume: boolean): void => {
        if (settled) return;
        settled = true;
        this.waiting.delete(node.id);
        controller.signal.removeEventListener('abort', onAbort);

        const said = question.said(outcome);
        this.store.answerQuestion(questionId, said);
        this.store.appendMessage({
          nodeId: node.id,
          runId,
          role: 'user',
          kind: 'text',
          content: said,
        });
        if (resume) {
          this.setStatus(node.id, 'running');
          this.bus.publish(node.project_id, { type: 'tree.updated', projectId: node.project_id });
        }
        resolve(outcome);
      };

      const onAbort = (): void => settle(question.stopped, false);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      // The waiter's kind decides which answer may release it, so the release
      // paths hand over the matching outcome type.
      this.waiting.set(node.id, {
        questionId,
        kind: question.kind,
        settle: settle as Waiter['settle'],
      });
    });
  }

  private finishRun(runId: string, nodeId: string, end: RunEnd, totals: RunTotals): void {
    this.store.finishRun(runId, end, totals);
    this.setStatus(nodeId, 'interrupted');
    const node = this.store.getNode(nodeId);
    if (node !== undefined) {
      this.bus.publish(node.project_id, { type: 'tree.updated', projectId: node.project_id });
    }
  }

  private setStatus(nodeId: string, status: NodeStatus): void {
    this.store.setNodeStatus(nodeId, status);
    const node = this.store.getNode(nodeId);
    if (node !== undefined) {
      this.bus.publish(node.project_id, { type: 'node.status', nodeId, status });
    }
  }
}
