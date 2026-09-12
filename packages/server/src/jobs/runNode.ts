import { randomUUID } from 'node:crypto';
import type { NodeStatus } from '@bonsai/shared';

import type { NodeRow, RunTotals, Store } from '../db/store.js';

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
}
import type { EventBus } from '../api/events.js';
import { silentLogger, type Logger } from '../log.js';
import type { AgentRunner } from '../agent/AgentRunner.js';
import { commitMessageFor, commitRunOutput } from '../git/commit.js';
import { branchNameFor } from '../git/repo.js';
import { readWorktreeState, resumePrompt } from '../git/recovery.js';

/**
 * D14d: runs are async jobs. Start returns a job id, progress streams, cancel
 * works, nothing blocks the UI.
 *
 * This pipeline is milestone-independent: M3 swaps the AgentRunner and changes
 * nothing here. What happens around the run -- freeze check, streaming,
 * commit-or-not, lineage bookkeeping -- is already final.
 */
export class RunJobs {
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly runner: AgentRunner,
    private readonly settings?: SettingsSource,
    private readonly log: Logger = silentLogger,
  ) {}

  isRunning(nodeId: string): boolean {
    return this.running.has(nodeId);
  }

  /** Cancellation exists from day one, not as a retrofit. */
  cancel(nodeId: string): boolean {
    const controller = this.running.get(nodeId);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  cancelAll(): void {
    for (const c of this.running.values()) c.abort();
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
    this.cancelAll();
    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0 && Date.now() < deadline) {
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

    const state = await readWorktreeState(node.worktree_path);
    const original = this.store.lastUserPrompt(nodeId) ?? node.description;
    return this.start(nodeId, resumePrompt(state, original));
  }

  start(nodeId: string, prompt: string): { runId: string } {
    const node = this.store.getNode(nodeId);
    if (node === undefined) throw new Error('no such node');
    if (this.running.has(nodeId)) throw new Error('this node is already running');

    /**
     * THE FREEZE IS RESOLVED HERE AND NOWHERE ELSE.
     *
     * Not continuously, and never re-checked mid-run. A run already in flight
     * is not invalidated by a sibling committing halfway through it: cancelling
     * paid, unreproducible work to honour a freeze that arrived late costs more
     * than it protects, and the child's base is pinned anyway, so nothing
     * downstream can go stale either way.
     *
     * A frozen node is NOT blocked from running. D4 freezes a node's code, not
     * its conversation -- "frozen nodes remain conversational, read-only" -- so
     * the freeze becomes a read-only tool set (D18) rather than a refusal.
     * Asking a finished node a question is a thing you are meant to be able to
     * do; it simply cannot write.
     */
    const view = this.store.treeView(node.project_id).find((n) => n.id === nodeId);
    const readOnly = view !== undefined && !view.writable;

    const runId = randomUUID();
    const controller = new AbortController();
    this.running.set(nodeId, controller);

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
    this.setStatus(nodeId, 'running');
    this.bus.publish(node.project_id, { type: 'run.started', nodeId, runId });

    void this.execute(runId, nodeId, prompt, readOnly, controller).finally(() => {
      this.running.delete(nodeId);
    });

    return { runId };
  }

  private async execute(
    runId: string,
    nodeId: string,
    prompt: string,
    readOnly: boolean,
    controller: AbortController,
  ): Promise<void> {
    // Fetched defensively rather than with `!`: these two lines sit outside the
    // try below, so a throw here would escape into an unhandled rejection and
    // take the process down instead of failing the run. A node deleted between
    // start and execute is unlikely but not impossible -- delete cancels a
    // running node rather than blocking on it.
    const node = this.store.getNode(nodeId);
    const project = node === undefined ? undefined : this.store.getProject(node.project_id);
    if (node === undefined || project === undefined) {
      this.store.finishRun(runId, 'failed', 'the node was removed before its run started', {
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
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
    const startedAt = Date.now();

    this.store.appendMessage({ nodeId, runId, role: 'user', kind: 'text', content: prompt });

    try {
      const inheritance = this.resolveInheritance(node);

      for await (const event of this.runner.run({
        runId,
        nodeId,
        cwd: node.worktree_path,
        prompt,
        resumeSessionId: inheritance.sessionId,
        forkSession: inheritance.fork,
        readOnly,
        // Node override, then the project's default, then the app setting.
        model: node.model ?? project.default_model ?? this.settings?.model() ?? null,
        effort: project.default_effort ?? this.settings?.effort() ?? null,
        permissionMode: node.permission_mode ?? project.default_permission_mode ?? 'acceptEdits',
        agentEnv: this.settings?.agentEnv() ?? null,
        signal: controller.signal,
      })) {
        switch (event.type) {
          case 'session':
            this.store.setSessionId(nodeId, event.sessionId);
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
          case 'tool':
            toolCalls += 1;
            seq += 1;
            this.store.appendMessage({
              nodeId,
              runId,
              role: 'assistant',
              kind: 'tool_use',
              content: { name: event.name, detail: event.detail },
            });
            this.bus.publish(node.project_id, {
              type: 'run.delta',
              nodeId,
              runId,
              seq,
              text: `${event.name}: ${event.detail}`,
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

      if (controller.signal.aborted) {
        this.log.info('run.cancelled', {
          runId,
          nodeId,
          durationMs: Date.now() - startedAt,
          toolCalls,
          costUsd: cost,
        });
        this.finishRun(runId, nodeId, 'cancelled', 'cancelled by the user', {
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
        ? { committed: false, commit: null, branch: null, changedPaths: [] }
        : await commitRunOutput({
            repoPath: project.repo_path,
            worktreePath: node.worktree_path,
            branchName: node.branch_name ?? branchNameFor(nodeId),
            message: commitMessageFor(node.display_name, node.description),
            fallbackContext: contextFallback(node.display_name, prompt),
          });

      const commitSha = outcome.commit;

      if (outcome.committed) {
        // D29: always a new commit, never an amend. A node is a branch that may
        // accumulate several commits while it is still a leaf.
        this.store.recordCommit(nodeId, outcome.branch!, outcome.commit!);
      }

      this.store.finishRun(runId, 'done', null, {
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
      });
      this.log.info('run.done', {
        runId,
        nodeId,
        projectId: node.project_id,
        model,
        effort: project.default_effort ?? this.settings?.effort() ?? null,
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
        this.finishRun(runId, nodeId, 'cancelled', 'cancelled by the user', {
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
        });
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
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
      this.finishRun(runId, nodeId, 'failed', message, {
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
      });
      this.bus.publish(node.project_id, { type: 'run.error', nodeId, runId, error: message });
    }
  }

  private finishRun(
    runId: string,
    nodeId: string,
    status: 'cancelled' | 'failed',
    error: string | null,
    totals: RunTotals,
  ): void {
    this.store.finishRun(runId, status, error, totals);
    this.setStatus(nodeId, 'interrupted');
    const node = this.store.getNode(nodeId);
    if (node !== undefined) {
      this.bus.publish(node.project_id, { type: 'tree.updated', projectId: node.project_id });
    }
  }

  /**
   * D16: memory across nodes is session forking.
   *
   * Three cases, and getting the first two the wrong way round is the bug this
   * milestone exists to avoid:
   *
   *   the node has its own session   -> RESUME it. §6.3: chatting with a leaf
   *                                     three times is one conversation.
   *   the node has none, its parent  -> FORK the parent's. The child inherits
   *   does                              the entire ancestor chain, the parent
   *                                     is left untouched, and siblings cannot
   *                                     see each other (D1, D2).
   *   neither                        -> a fresh session. Master's first run.
   *
   * Note the parent is the CONVERSATIONAL parent, always. It is the git base
   * that skips commitless ancestors, not the session -- that divergence is the
   * whole point (PRD §4), and it is why this walks no tree at all.
   */
  private resolveInheritance(node: NodeRow): { sessionId: string | null; fork: boolean } {
    if (node.session_id !== null) return { sessionId: node.session_id, fork: false };
    if (node.parent_id === null) return { sessionId: null, fork: false };

    const parent = this.store.getNode(node.parent_id);
    if (parent?.session_id == null) return { sessionId: null, fork: false };

    // A3: record where the fork was taken. A frozen node stays conversational,
    // so two children of one parent can inherit different amounts of it.
    this.store.recordFork(node.id, this.store.messageCount(parent.id));
    return { sessionId: parent.session_id, fork: true };
  }

  private setStatus(nodeId: string, status: NodeStatus): void {
    this.store.setNodeStatus(nodeId, status);
    const node = this.store.getNode(nodeId);
    if (node !== undefined) {
      this.bus.publish(node.project_id, { type: 'node.status', nodeId, status });
    }
  }
}
