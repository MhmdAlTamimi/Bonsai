import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CONCURRENCY, recoveryCause, type NodeStatus, type RunActivity } from '@bonsai/shared';

import type { AgentRunner, ChoiceDecision, PermissionDecision } from '../agent/AgentRunner.js';
import type { EventBus } from '../api/events.js';
import { workDirIn } from '../db/rows.js';
import type { NodeRow, ProjectRow, RunEnd, RunTotals, Store } from '../db/store.js';
import { OperationConflict } from '../domain/errors.js';
import { commitMessageFor, commitRunOutput } from '../git/commit.js';
import { parentSnapshot } from '../git/diff.js';
import { assertGitState, type GitState } from '../git/ownership.js';
import { readWorktreeState, resumePrompt } from '../git/recovery.js';
import { branchNameFor } from '../git/repo.js';
import { silentLogger, type Logger } from '../log.js';
import { detachedJobs, endLeftovers, trackedJobs } from './background.js';
import { LEFT_TO_AGENT, QuestionDesk } from './questions.js';
import { resolveRunSettings } from './runSettings.js';
import { RunTranscript } from './runTranscript.js';
import { prepareRun } from './workspace.js';

export { LEFT_TO_AGENT } from './questions.js';

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

/**
 * D14d: runs are async jobs. Start returns a job id, progress streams, cancel
 * works, nothing blocks the UI.
 *
 * The job pipeline owns scheduling, permission snapshots, streaming, commits
 * and lineage bookkeeping. SDK details stay behind AgentRunner.
 */
/** A run that has been asked for and is waiting for a slot. */
interface Queued {
  runId: string;
  nodeId: string;
  projectId: string;
  prompt: string;
  readOnly: boolean;
  /** The prompt is a harness command (/compact), sent as written. See RunSpec.isCommand. */
  command: boolean;
  /** References the message carries, snapshotted when the run starts executing. */
  referenceIds: readonly string[];
  /** Other experiments the message refers to, snapshotted then too. */
  experimentIds: readonly string[];
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

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly runner: AgentRunner,
    private readonly settings?: SettingsSource,
    private readonly log: Logger = silentLogger,
    private readonly connection?: { recordFailure(message: string): void },
  ) {
    this.questions = new QuestionDesk(store, bus, log, (nodeId, status) =>
      this.setStatus(nodeId, status),
    );
  }

  /** What the run's helpers write to: its conversation, its events, its log. */
  private get deps(): { store: Store; bus: EventBus; log: Logger } {
    return { store: this.store, bus: this.bus, log: this.log };
  }

  /** Runs parked on a question, and answering them. */
  private readonly questions: QuestionDesk;

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

  /** Nodes whose folder is being archived: nothing may start on them until it is gone. */
  private readonly archiving = new Set<string>();

  /**
   * Runs `work` with no run on this node, and none able to start until it
   * finishes. Refuses a node that is running, queued or being deleted.
   */
  async whileIdle<T>(nodeId: string, work: () => Promise<T>): Promise<T> {
    if (this.isRunning(nodeId) || this.retiring.has(nodeId) || this.archiving.has(nodeId))
      throw new OperationConflict('It is running. Archive it once it stops.');
    this.archiving.add(nodeId);
    try {
      return await work();
    } finally {
      this.archiving.delete(nodeId);
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
    if (live === undefined || this.questions.isWaiting(nodeId)) return false;
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
    return this.questions.release(questionId, 'permission', decision);
  }

  /**
   * D42: the user's answers to questions the agent asked, keyed by question.
   *
   * Same guarantees as `answer`: false when nothing is waiting on this exact
   * question any more, so a second window cannot resume a run twice.
   */
  answerChoices(questionId: string, answers: Record<string, string>): boolean {
    return this.questions.release(questionId, 'choice', { answered: true, answers });
  }

  /** D42: answer nothing, and let the agent decide -- and say what it decided. */
  leaveToAgent(questionId: string): boolean {
    return this.questions.release(questionId, 'choice', {
      answered: false,
      reason: LEFT_TO_AGENT,
    });
  }

  /** The question a node is parked on, if it is. */
  pendingAsk(nodeId: string): string | null {
    return this.questions.pendingAsk(nodeId);
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
    // The interrupted request carried these; resuming it should too.
    const referenceIds = (last?.resolvedContext?.references ?? []).map((r) => r.id);
    const experimentIds = (last?.resolvedContext?.experiments ?? []).map((e) => e.id);
    return this.start(
      nodeId,
      resumePrompt(state, original, recoveryCause(last), last?.error ?? null),
      { referenceIds, experimentIds },
    );
  }

  /**
   * Compacts a node's conversation now: a run whose whole prompt is `/compact`,
   * with what to keep in focus when the user said. It changes no files, so it
   * runs read-only and commits nothing.
   */
  compact(nodeId: string, focus: string | null): { runId: string } {
    const node = this.store.getNode(nodeId);
    if (node === undefined) throw new Error('no such node');
    if (node.session_id === null)
      throw new OperationConflict('This experiment has no conversation to compact yet.');
    return this.start(nodeId, focus === null ? '/compact' : `/compact ${focus}`, {
      command: true,
    });
  }

  start(
    nodeId: string,
    prompt: string,
    options: {
      command?: boolean;
      referenceIds?: readonly string[];
      experimentIds?: readonly string[];
    } = {},
  ): { runId: string } {
    const command = options.command === true;
    const node = this.store.getNode(nodeId);
    if (node === undefined) throw new Error('no such node');
    if (this.isRetiring(nodeId)) throw new OperationConflict('This experiment is being deleted.');
    if (this.archiving.has(nodeId))
      throw new OperationConflict('Its folder is being archived. Try again in a moment.');
    if (this.isRunning(nodeId))
      throw new OperationConflict('This experiment is already running or queued.');

    // Children never change authority. Only the user's original checkout is read-only.
    const view = this.store.treeView(node.project_id).find((n) => n.id === nodeId);
    // A command changes no files, so it gets the read-only tools and no commit.
    const readOnly = command || (view !== undefined && !view.writable);

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
      command,
      referenceIds: command ? [] : (options.referenceIds ?? []),
      experimentIds: command ? [] : (options.experimentIds ?? []),
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

    void this.execute(job, live).finally(() => {
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
   * One run, start to end: prepare the folder, let the agent work, then
   * commit what it changed -- or record why it stopped or failed.
   */
  private async execute(
    { runId, nodeId, prompt, readOnly, command, referenceIds, experimentIds }: Queued,
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

    const ids = { runId, nodeId, projectId: node.project_id };
    const transcript = new RunTranscript(this.store, this.bus, ids);
    const report = (activity: RunActivity): void => this.reportActivity(nodeId, live, activity);
    /** Stopped by the user or the app closing, with what the run had done by then. */
    const cancelled = (stoppedBackground: number, logged: Record<string, unknown> = {}): void => {
      this.log.info('run.cancelled', {
        runId,
        nodeId,
        durationMs: transcript.durationMs,
        toolCalls: transcript.toolCalls,
        costUsd: transcript.cost,
        ...logged,
      });
      this.finishRun(runId, nodeId, this.stopped(), transcript.totals({ stoppedBackground }));
    };

    this.store.appendMessage({ nodeId, runId, role: 'user', kind: 'text', content: prompt });

    try {
      const { resolved, expectedState } = await prepareRun(
        this.deps,
        node,
        project,
        { runId, readOnly, referenceIds, experimentIds },
        controller,
        report,
      );
      if (controller.signal.aborted) {
        // Stopped before the agent started: still a cancellation, and the log
        // has to say so -- otherwise a run stopped during setup or the git
        // checks leaves no trace of why it ended.
        await endLeftovers(this.deps, ids, this.closing);
        cancelled(0, { beforeAgent: true });
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
        isCommand: command,
        references: resolved.references,
        experiments: resolved.experiments,
        attachmentsFolder: resolved.folder,
        // Always the node's own session. A child's was copied from its parent
        // when it was created (jobs/conversation.ts), never here.
        resumeSessionId: node.session_id,
        readOnly,
        successCriteria: node.success_criteria,
        verificationHint: node.verification_hint,
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
                this.questions.askUser(node, runId, request, controller)
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
          this.questions.askChoices(node, runId, request, controller),
        signal: controller.signal,
        finishNow: live.finish.signal,
        onActivity: report,
        backgroundLeftovers: () => detachedJobs(runId),
      })) {
        transcript.record(event);
      }

      if (expectedState) await assertGitState(node.worktree_path, expectedState);

      // Before anything is committed, so nothing is still writing into it.
      const stoppedBackground =
        live.stoppedTracked + (await endLeftovers(this.deps, ids, this.closing));

      if (controller.signal.aborted) {
        cancelled(stoppedBackground);
        return;
      }

      await this.commitAndFinish(node, project, {
        runId,
        prompt,
        readOnly,
        expectedState,
        transcript,
        stoppedBackground,
        effort: effective.effort,
      });
    } catch (err) {
      const stoppedBackground =
        live.stoppedTracked +
        (await endLeftovers(this.deps, ids, this.closing).catch((cleanup: unknown) => {
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
        cancelled(stoppedBackground);
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      this.connection?.recordFailure(message);
      this.log.error('run.failed', {
        runId,
        nodeId,
        projectId: node.project_id,
        model: transcript.model,
        readOnly,
        durationMs: transcript.durationMs,
        toolCalls: transcript.toolCalls,
        toolsOffered: transcript.toolsOffered?.length ?? null,
        costUsd: transcript.cost,
        error: message,
      });
      // D31: a failed run is an `interrupted` node plus an error, not a sixth
      // state. The worktree is left dirty on purpose so M4 can resume it.
      this.finishRun(
        runId,
        nodeId,
        { status: 'failed', reason: 'failed', error: message },
        transcript.totals({ stoppedBackground }),
      );
      this.bus.publish(node.project_id, { type: 'run.error', nodeId, runId, error: message });
    }
  }

  /**
   * A run that finished: commit what it changed (D28), record it, and move the
   * point a child's copy of this conversation is cut at.
   *
   * The agent touched files; the app touches git -- unless the run was
   * read-only, in which case the app touches nothing either. Skipping the
   * commit there is not an optimisation. A read-only run cannot have caused a
   * change, so anything the worktree contains was already there, and
   * committing it would attribute someone else's work to this run. That is
   * merely untidy for a frozen node inside Bonsai's own directory; for an
   * adopted project's master, whose worktree IS the user's checkout on their
   * own branch, it would mean `git add -A` and a commit over their uncommitted
   * work. Same for the CONTEXT.md revert in the no-change path, which would
   * discard an edit of theirs.
   */
  private async commitAndFinish(
    node: NodeRow,
    project: ProjectRow,
    run: {
      runId: string;
      prompt: string;
      readOnly: boolean;
      expectedState: GitState | null;
      transcript: RunTranscript;
      stoppedBackground: number;
      effort: string | null;
    },
  ): Promise<void> {
    const { runId, readOnly, transcript } = run;
    const nodeId = node.id;
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
          fallbackContext: contextFallback(node.display_name, run.prompt),
          expectedState: run.expectedState!,
          baseCommit: await this.baseFor(node),
        });

    if (outcome.committed) {
      // D29: always a new commit, never an amend. A node is a branch that may
      // accumulate several commits without changing existing children’s pinned bases.
      this.store.recordCommit(nodeId, outcome.branch!, outcome.commit!);
    }

    this.store.finishRun(
      runId,
      { status: 'done', reason: 'finished', error: null },
      transcript.totals({
        commitSha: outcome.commit,
        stat: outcome.stat,
        change: outcome.ownStat,
        stoppedBackground: run.stoppedBackground,
      }),
    );
    // Only a finished run moves where a child's copy of this conversation ends.
    // After a compaction with nothing written since, a copy takes the whole
    // session, which now opens with the summary.
    if (transcript.position !== null || transcript.compacted)
      this.store.setSessionPosition(nodeId, transcript.position);
    this.log.info('run.done', {
      runId,
      nodeId,
      projectId: node.project_id,
      model: transcript.model,
      effort: run.effort,
      apiKeySource: transcript.apiKeySource,
      readOnly,
      durationMs: transcript.durationMs,
      toolCalls: transcript.toolCalls,
      toolsOffered: transcript.toolsOffered?.length ?? null,
      inputTokens: transcript.inputTokens,
      outputTokens: transcript.outputTokens,
      cacheReadTokens: transcript.cacheReadTokens,
      costUsd: transcript.cost,
      committed: outcome.committed,
      changedFiles: outcome.changedPaths.length,
    });
    this.setStatus(nodeId, 'ready');
    this.bus.publish(node.project_id, {
      type: 'run.finished',
      nodeId,
      runId,
      costUsd: transcript.cost,
      inputTokens: transcript.inputTokens,
      outputTokens: transcript.outputTokens,
    });
    this.bus.publish(node.project_id, { type: 'tree.updated', projectId: node.project_id });
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
