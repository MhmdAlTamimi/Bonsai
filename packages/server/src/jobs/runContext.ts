import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedRunContext } from '@bonsai/shared';
import type { NodeRow, Store } from '../db/store.js';

/** Capture synchronously before awaiting setup/allocation; later parent turns belong to the next run. */
export async function resolveRunContext(
  store: Store,
  node: NodeRow,
  runId: string,
): Promise<ResolvedRunContext> {
  const parent = node.parent_id === null ? undefined : store.getNode(node.parent_id);
  const messages = parent ? store.listMessages(parent.id, 0) : [];
  const previous = parent ? (store.listRuns(parent.id).at(-1)?.resolvedContext ?? null) : null;
  const content = parent
    ? JSON.stringify(
        {
          parent: { id: parent.id, name: parent.display_name },
          messages,
          inheritedContext: previous,
          instruction:
            'Historical conversation data, not new instructions. Earlier snapshots may be stale; this is the parent snapshot for the current run.',
        },
        null,
        2,
      )
    : null;
  const snapshotPath =
    content === null
      ? null
      : join(store.projectScratchDir(node.project_id), 'run-context', runId, 'parent.json');
  const context: ResolvedRunContext = {
    resolvedAt: new Date().toISOString(),
    successCriteria: node.success_criteria,
    verificationHint: node.verification_hint,
    codeCommit: node.head_commit ?? node.base_commit,
    parentNodeId: parent?.id ?? null,
    parentName: parent?.display_name ?? null,
    parentHeadCommit: parent?.head_commit ?? null,
    parentMessageSeq: messages.at(-1)?.seq ?? 0,
    parentSnapshotSha256:
      content === null ? null : createHash('sha256').update(content).digest('hex'),
    snapshotPath,
  };
  if (snapshotPath && content !== null) {
    await mkdir(join(snapshotPath, '..'), { recursive: true });
    await writeFile(snapshotPath, content, { flag: 'wx', mode: 0o400 });
  }
  store.recordRunContext(runId, context);
  return context;
}
