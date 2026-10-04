import type { ConversationCopier } from '../agent/AgentRunner.js';
import type { Store } from '../db/store.js';
import type { Logger } from '../log.js';
import { workDirIn } from '../db/rows.js';
import { inheritedConversationKey, savedConversation } from './conversationRecovery.js';

export type ConversationCopy = 'copied' | 'nothing to copy' | 'failed';

/**
 * Gives a new child its own copy of its parent's conversation.
 *
 * Done once, at creation, so the conversation a child starts with matches the
 * code it was pinned to at the same moment: both reflect the parent's last
 * FINISHED run. The copy is cut at that run's last message (`session_position`)
 * rather than wherever the parent happens to be, so creating a child while
 * the parent is working never hands it half an exchange. A parent with no
 * recorded message position uses the completed durable SDK checkpoint, including
 * after compaction. Unfinished parent turns are excluded from both native and
 * saved-history copies.
 *
 * A failed native copy preserves a bounded, fixed copy of Bonsai's history.
 * The child's first message rebuilds from that copy and says so explicitly.
 */
export async function copyParentConversation(
  store: Store,
  copier: ConversationCopier,
  childId: string,
  log: Logger,
): Promise<ConversationCopy> {
  const child = store.getNode(childId);
  const parent = child?.parent_id ? store.getNode(child.parent_id) : undefined;
  if (child === undefined || parent === undefined) return 'nothing to copy';

  const messages = store.listMessages(parent.id, 0);
  const completed = store
    .listRuns(parent.id)
    .filter((run) => run.status === 'done')
    .at(-1);
  const endSeq =
    completed === undefined
      ? (messages.filter((message) => message.runId === null).at(-1)?.seq ?? 0)
      : (messages.filter((message) => message.runId === completed.id).at(-1)?.seq ?? 0);
  const history = savedConversation(store, parent.id, { through: endSeq });
  const boundaryText = store.metadata(`session_boundary:${parent.id}`);
  const checkpoint = boundaryText === null ? null : Number(boundaryText);
  const cwd = workDirIn(parent.worktree_path, store.getProject(parent.project_id)!.work_dir);
  if (history.trim() === '' && completed === undefined && checkpoint === null)
    return 'nothing to copy';
  // Written before the SDK copy so a crash cannot strand the child's only context.
  store.setMetadata(inheritedConversationKey(child.id), history);

  try {
    if (parent.session_id === null) throw new Error('Claude session is unavailable');
    if (checkpoint === null && parent.session_position === null)
      throw new Error('The original session has no verified completed boundary');
    if (
      copier.conversationAvailable &&
      !(await copier.conversationAvailable(parent.session_id, cwd))
    )
      throw new Error('Claude session is unavailable');
    const sessionId = await copier.forkConversation(
      parent.session_id,
      parent.session_position,
      cwd,
      checkpoint,
    );
    store.adoptForkedSession(child.id, sessionId, endSeq);
    return 'copied';
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn('node.conversation_copy_failed', {
      nodeId: child.id,
      parentId: parent.id,
      error: reason,
    });
    store.adoptForkedSession(child.id, null, endSeq);
    store.appendMessage({
      nodeId: child.id,
      runId: null,
      role: 'system',
      kind: 'text',
      content:
        `Could not copy ${parent.display_name}'s conversation (${reason}). ` +
        'Its first message will start a new Claude session using the saved Bonsai conversation. Older messages and tool output may be shortened; its code is inherited as usual.',
    });
    return 'failed';
  }
}
