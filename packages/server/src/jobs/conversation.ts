import type { ConversationCopier } from '../agent/AgentRunner.js';
import type { Store } from '../db/store.js';
import type { Logger } from '../log.js';

export type ConversationCopy = 'copied' | 'nothing to copy' | 'failed';

/**
 * Gives a new child its own copy of its parent's conversation.
 *
 * Done once, at creation, so the conversation a child starts with matches the
 * code it was pinned to at the same moment: both reflect the parent's last
 * FINISHED run. The copy is cut at that run's last message (`session_position`)
 * rather than wherever the parent happens to be, so creating a child while
 * the parent is working never hands it half an exchange. A parent with no
 * recorded position -- nothing has finished since positions were recorded --
 * is copied whole.
 *
 * A failed copy does not fail creation. The child is still a valid experiment
 * with its code; it just starts talking from nothing, and says so in its own
 * transcript rather than leaving the user to discover it from the agent's
 * answers.
 */
export async function copyParentConversation(
  store: Store,
  copier: ConversationCopier,
  childId: string,
  log: Logger,
): Promise<ConversationCopy> {
  const child = store.getNode(childId);
  const parent = child?.parent_id ? store.getNode(child.parent_id) : undefined;
  if (child === undefined || parent?.session_id == null) return 'nothing to copy';

  try {
    const sessionId = await copier.forkConversation(parent.session_id, parent.session_position);
    store.adoptForkedSession(child.id, sessionId, store.messageCount(parent.id));
    return 'copied';
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn('node.conversation_copy_failed', {
      nodeId: child.id,
      parentId: parent.id,
      error: reason,
    });
    store.appendMessage({
      nodeId: child.id,
      runId: null,
      role: 'system',
      kind: 'text',
      content:
        `Could not copy ${parent.display_name}'s conversation (${reason}). ` +
        'This experiment starts without it; its code is inherited as usual.',
    });
    return 'failed';
  }
}
