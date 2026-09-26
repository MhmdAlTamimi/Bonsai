import type { RunActivity } from '@bonsai/shared';

import type { EventBus } from '../api/events.js';
import type { NodeRow, Store } from '../db/store.js';
import { workDirIn } from '../db/rows.js';
import { runCommand, summarise } from '../exec/command.js';
import { status } from '../git/exec.js';
import type { Logger } from '../log.js';

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
export async function ensureSetup(
  deps: { store: Store; bus: EventBus; log: Logger },
  node: NodeRow,
  project: { setup_command: string | null; id: string; work_dir: string | null },
  runId: string,
  controller: AbortController,
  report: (activity: RunActivity) => void,
): Promise<void> {
  const command = project.setup_command;
  if (command === null || command.trim() === '') return;
  // Once per node. Recorded in the database so a restart mid-install does
  // not mean running it again on every message from then on.
  if (node.setup_ran_at !== null) return;
  if (controller.signal.aborted) return;

  // A cold `npm install` takes minutes, and should read as running, not stuck.
  report({
    state: 'working',
    tool: { name: 'Setup', detail: command, startedAt: new Date().toISOString() },
    background: [],
  });

  deps.store.appendMessage({
    nodeId: node.id,
    runId,
    role: 'system',
    kind: 'text',
    content: `Setting up this node: ${command}`,
  });
  deps.bus.publish(node.project_id, {
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
      deps.bus.publish(node.project_id, {
        type: 'run.delta',
        nodeId: node.id,
        runId,
        seq: 0,
        text: chunk,
      });
    },
  });

  report({ state: 'working', tool: null, background: [] });
  deps.log.info('node.setup', {
    nodeId: node.id,
    projectId: node.project_id,
    ok: result.ok,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
  });

  deps.store.appendMessage({
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
    deps.store.appendMessage({
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
  if (!controller.signal.aborted) deps.store.markSetupRan(node.id);
}
