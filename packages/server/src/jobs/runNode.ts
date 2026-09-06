import { randomUUID } from 'node:crypto';
import type { NodeStatus } from '@bonsai/shared';

import type { Store } from '../db/store.js';
import type { EventBus } from '../api/events.js';
import type { AgentRunner } from '../agent/AgentRunner.js';
import { commitMessageFor, commitRunOutput } from '../git/commit.js';
import { branchNameFor } from '../git/repo.js';

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

  start(nodeId: string, prompt: string): { runId: string } {
    const node = this.store.getNode(nodeId);
    if (node === undefined) throw new Error('no such node');
    if (this.running.has(nodeId)) throw new Error('this node is already running');

    /**
     * THE FREEZE IS CHECKED HERE AND NOWHERE ELSE.
     *
     * Not continuously, and never re-checked mid-run. A run already in flight
     * is not invalidated by a sibling committing halfway through it: cancelling
     * paid, unreproducible work to honour a freeze that arrived late costs more
     * than it protects, and the child's base is pinned anyway, so nothing
     * downstream can go stale either way.
     */
    const view = this.store.treeView(node.project_id).find((n) => n.id === nodeId);
    if (view !== undefined && !view.writable) {
      throw new Error('this node is frozen: a child has committed, so create a child instead');
    }

    const runId = randomUUID();
    const controller = new AbortController();
    this.running.set(nodeId, controller);

    this.store.createRun(runId, nodeId);
    this.setStatus(nodeId, 'running');
    this.bus.publish(node.project_id, { type: 'run.started', nodeId, runId });

    void this.execute(runId, nodeId, prompt, controller).finally(() => {
      this.running.delete(nodeId);
    });

    return { runId };
  }

  private async execute(
    runId: string,
    nodeId: string,
    prompt: string,
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
      this.store.finishRun(runId, 'failed', 'the node was removed before its run started', 0, 0, 0);
      return;
    }

    let seq = 0;
    let cost = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    this.store.appendMessage({ nodeId, runId, role: 'user', kind: 'text', content: prompt });

    try {
      for await (const event of this.runner.run({
        runId,
        nodeId,
        cwd: node.worktree_path,
        prompt,
        resumeSessionId: node.session_id,
        readOnly: false,
        model: node.model ?? project.default_model,
        permissionMode: node.permission_mode ?? project.default_permission_mode,
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
          case 'done':
            cost = event.costUsd;
            inputTokens = event.inputTokens;
            outputTokens = event.outputTokens;
            break;
          case 'error':
            throw new Error(event.error);
        }
      }

      if (controller.signal.aborted) {
        this.finishRun(runId, nodeId, 'cancelled', 'cancelled by the user', cost, inputTokens, outputTokens);
        return;
      }

      // The agent touched files; the app touches git (D28).
      const outcome = await commitRunOutput({
        repoPath: project.repo_path,
        worktreePath: node.worktree_path,
        branchName: node.branch_name ?? branchNameFor(nodeId),
        message: commitMessageFor(node.display_name, node.description),
      });

      if (outcome.committed) {
        // D29: always a new commit, never an amend. A node is a branch that may
        // accumulate several commits while it is still a leaf.
        this.store.recordCommit(nodeId, outcome.branch!, outcome.commit!);
      }

      this.store.finishRun(runId, 'done', null, cost, inputTokens, outputTokens);
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
      const message = err instanceof Error ? err.message : String(err);
      // D31: a failed run is an `interrupted` node plus an error, not a sixth
      // state. The worktree is left dirty on purpose so M4 can resume it.
      this.finishRun(runId, nodeId, 'failed', message, cost, inputTokens, outputTokens);
      this.bus.publish(node.project_id, { type: 'run.error', nodeId, runId, error: message });
    }
  }

  private finishRun(
    runId: string,
    nodeId: string,
    status: 'cancelled' | 'failed',
    error: string | null,
    cost: number,
    inputTokens: number,
    outputTokens: number,
  ): void {
    this.store.finishRun(runId, status, error, cost, inputTokens, outputTokens);
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
