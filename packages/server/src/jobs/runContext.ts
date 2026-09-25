import type { ResolvedRunContext } from '@bonsai/shared';
import type { NodeRow, Store } from '../db/store.js';

/**
 * What a run is given, fixed and recorded when it starts executing.
 *
 * Called before anything is awaited (setup, checkout allocation), so what the
 * user changes after pressing send -- a new goal, a parent that keeps working
 * -- belongs to the next run rather than leaking into this one.
 *
 * The conversation is deliberately absent. The node resumes its own session,
 * which for a child is a copy of its parent's taken at creation; handing it a
 * fresher transcript of the parent here would describe code the child's
 * checkout does not have.
 */
export function resolveRunContext(store: Store, node: NodeRow, runId: string): ResolvedRunContext {
  const parent = node.parent_id === null ? undefined : store.getNode(node.parent_id);
  const context: ResolvedRunContext = {
    resolvedAt: new Date().toISOString(),
    successCriteria: node.success_criteria,
    verificationHint: node.verification_hint,
    codeCommit: node.head_commit ?? node.base_commit,
    parentNodeId: parent?.id ?? null,
    parentName: parent?.display_name ?? null,
    parentHeadCommit: parent?.head_commit ?? null,
  };
  store.recordRunContext(runId, context);
  return context;
}
