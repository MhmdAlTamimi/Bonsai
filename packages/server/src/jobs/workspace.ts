import type { RunActivity } from '@bonsai/shared';

import type { EventBus } from '../api/events.js';
import type { NodeRow, ProjectRow, Store } from '../db/store.js';
import { assertGitState, expectedGitState, type GitState } from '../git/ownership.js';
import type { Logger } from '../log.js';
import { allocateNodeWorktree } from '../projects.js';
import { resolveRunContext, type RunAttachments } from './runContext.js';
import { ensureSetup } from './setup.js';

/**
 * Everything a run needs before its agent starts: what the message carries,
 * the experiment's folder, and the git state the run must leave untouched.
 *
 * In this order, and each step once:
 *
 *   1. what the message carries (references, other experiments) is fixed and
 *      recorded, before anything is awaited that could let an edit slip in;
 *   2. the folder is allocated -- created at its recorded path the first time,
 *      or again after it was archived -- and its copy-in files are seeded;
 *   3. the git state is read and checked, the setup command runs once, and the
 *      state is checked again, because setup writes files under the same rules
 *      as the agent.
 *
 * A read-only run skips the git state and setup: it changes nothing, so there
 * is nothing to protect and nothing to install.
 */
export async function prepareRun(
  deps: { store: Store; bus: EventBus; log: Logger },
  node: NodeRow,
  project: ProjectRow,
  run: {
    runId: string;
    readOnly: boolean;
    referenceIds: readonly string[];
    experimentIds: readonly string[];
  },
  controller: AbortController,
  report: (activity: RunActivity) => void,
): Promise<{ resolved: RunAttachments; expectedState: GitState | null }> {
  const { store } = deps;
  const { runId, readOnly } = run;
  const note = (content: string): void => {
    store.appendMessage({ nodeId: node.id, runId, role: 'system', kind: 'text', content });
  };

  const resolved = await resolveRunContext(store, node, runId, {
    referenceIds: run.referenceIds,
    experimentIds: run.experimentIds,
  });
  for (const [count, one, many] of [
    [resolved.missing.references, 'A reference was', 'references were'],
    [resolved.missing.experiments, 'A referenced experiment was', 'referenced experiments were'],
  ] as const) {
    if (count === 0) continue;
    note(
      `${count === 1 ? one : `${count} ${many}`} deleted before this run started, so ${count === 1 ? 'it was' : 'they were'} not attached.`,
    );
  }

  if (controller.signal.aborted) throw new Error('Cancelled before allocation.');
  const seeded = await allocateNodeWorktree(store, node);
  for (const outcome of seeded)
    if (!outcome.copied)
      note(`Could not copy ${outcome.path}: ${outcome.reason ?? 'unknown reason'}`);

  const expectedState = readOnly ? null : await expectedGitState(project.repo_path, node);
  if (expectedState) await assertGitState(node.worktree_path, expectedState);
  // Setup mutates files and obeys the same ownership boundary as agent writes.
  if (!readOnly) await ensureSetup(deps, node, project, runId, controller, report);
  if (expectedState) await assertGitState(node.worktree_path, expectedState);
  return { resolved, expectedState };
}
