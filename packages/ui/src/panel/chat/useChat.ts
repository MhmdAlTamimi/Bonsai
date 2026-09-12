import { useEffect, useRef, useState, type RefObject } from 'react';
import type { MessageView, NodeView } from '@bonsai/shared';

import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';
import { pendingDeltas, type Delta } from './liveMerge.ts';

/**
 * The conversation's state, separated from where it is drawn.
 *
 * A hook rather than a component because the panel needs its two halves in two
 * different places: the transcript scrolls with the rest of the panel, and the
 * composer is pinned to the bottom where it is always reachable. Those cannot
 * be one element, and threading the prompt through props would put chat state
 * in a component that has no other business with it.
 *
 * Fixing the scroll trap is the point. The log used to be `max-height: 48vh;
 * overflow-y: auto` INSIDE a panel that also scrolled, so the wheel did
 * different things twenty pixels apart and a long transcript was read through a
 * letterbox. There is one scrolling region now.
 */
export function useChat(
  node: NodeView,
  live: readonly Delta[],
  onChanged: () => void,
  onError: (message: string | null) => void,
): {
  messages: MessageView[];
  /** Live deltas the persisted transcript has not caught up with. */
  pending: Delta[];
  prompt: string;
  setPrompt: (value: string) => void;
  sending: boolean;
  busy: boolean;
  running: boolean;
  send: () => void;
  /** Attach to the scrolling region so new output follows the tail. */
  scrollRef: RefObject<HTMLDivElement | null>;
} {
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .messages(node.id)
      .then((m) => alive && setMessages(m))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [node.id, node.status]);

  /**
   * Follow the tail, but only when the reader is already at it.
   *
   * Scrolling to the bottom unconditionally yanks the view away from someone
   * reading back through an earlier run while the agent is still working --
   * which, with several nodes in flight, is exactly when they are most likely
   * to be doing it.
   */
  useEffect(() => {
    const region = scrollRef.current;
    if (region === null) return;
    const distance = region.scrollHeight - region.scrollTop - region.clientHeight;
    if (distance < 160) region.scrollTop = region.scrollHeight;
  }, [messages.length, live.length, node.status]);

  const running = node.status === 'running';
  /**
   * A parked node is not `running`, but it is just as busy: its agent is alive
   * and holding a question. Sending it a new message would be rejected by the
   * server ("this node is already running"), so the composer says so instead.
   */
  const busy = running || node.status === 'needs_you';

  const send = (): void => {
    const text = prompt.trim();
    if (text === '' || busy || sending) return;
    setSending(true);
    onError(null);
    void api
      .startRun(node.id, text)
      .then(() => {
        setPrompt('');
        onChanged();
      })
      .catch((e: unknown) => onError(describeError(e)))
      .finally(() => setSending(false));
  };

  return {
    messages,
    pending: running ? pendingDeltas(live, messages) : [],
    prompt,
    setPrompt,
    sending,
    busy,
    running,
    send,
    scrollRef,
  };
}
