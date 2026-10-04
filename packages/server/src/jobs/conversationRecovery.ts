import type { Store } from '../db/store.js';
import { conversationText } from '../domain/conversationText.js';
import type { MessageView } from '@bonsai/shared';

const HISTORY_BUDGET = 24_000;
export const inheritedConversationKey = (nodeId: string): string => `conversation_seed:${nodeId}`;

export function boundedConversation(
  messages: ReadonlyArray<Pick<MessageView, 'role' | 'kind' | 'content'>>,
  budget: number,
): string {
  if (messages.length === 0) return '';
  const text = conversationText(messages, null, budget).text;
  if (text.length <= budget) return text;
  const gap = '\n[Long message shortened to fit the saved conversation]\n';
  const half = Math.floor((budget - gap.length) / 2);
  return `${text.slice(0, half)}${gap}${text.slice(-half)}`;
}

/** Bounded durable fallback, including the inherited context fixed at creation. */
export function savedConversation(
  store: Store,
  nodeId: string,
  options: { through?: number; excludeRunId?: string } = {},
): string {
  const inherited = store.metadata(inheritedConversationKey(nodeId));
  const messages = store
    .listMessages(nodeId, 0)
    .filter(
      (message) =>
        (options.through === undefined || message.seq <= options.through) &&
        (options.excludeRunId === undefined || message.runId !== options.excludeRunId),
    );
  const own = boundedConversation(
    messages,
    inherited === null ? HISTORY_BUDGET : HISTORY_BUDGET / 2,
  );
  return inherited === null
    ? own
    : `Inherited conversation at creation:\n${inherited.slice(0, HISTORY_BUDGET / 2)}\n\nThis experiment's conversation:\n${own}`;
}

export const CONVERSATION_RECOVERY_NOTICE =
  'Claude’s original session is unavailable. Starting a new conversation using Bonsai’s saved history and inherited context. Older messages and tool output may be shortened.';

export const SAVED_CONTEXT_NOTICE =
  'Starting a new Claude session using Bonsai’s saved conversation and inherited context. Older messages and tool output may be shortened.';
