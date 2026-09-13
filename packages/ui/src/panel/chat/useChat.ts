import { useEffect, useState } from 'react';
import type { MessageView, NodeView } from '@bonsai/shared';

import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';
import { clearSubmittedDraft, setSending, isSending } from './drafts.ts';
import { useDraft } from './useDraft.ts';
import { pendingDeltas, type Delta } from './liveMerge.ts';

/** Node-scoped history and drafts, shared by the transcript and fixed composer. */
export function useChat(
  node: NodeView,
  live: readonly Delta[],
  streamRevision: number,
  onChanged: () => void,
  onError: (message: string | null) => void,
): {
  messages: MessageView[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  retry: () => void;
  /** Live deltas the persisted transcript has not caught up with. */
  pending: Delta[];
  prompt: string;
  setPrompt: (value: string) => void;
  sending: boolean;
  busy: boolean;
  running: boolean;
  send: () => void;
} {
  const [messages, setMessages] = useState<MessageView[]>([]);
  const { key, prompt, setPrompt, sending } = useDraft(
    node.projectId,
    node.id,
    'reply',
    node.status === 'new' ? node.summaryLine : '',
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void api
      .messages(node.id, 0, controller.signal)
      .then((m) => {
        if (alive) {
          setMessages(m);
          setLoaded(true);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setError(describeError(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [node.id, node.status, revision, streamRevision]);

  const running = node.status === 'running';
  /**
   * A parked node is not `running`, but it is just as busy: its agent is alive
   * and holding a question. Sending it a new message would be rejected by the
   * server ("this node is already running"), so the composer says so instead.
   */
  const busy = running || node.status === 'needs_you';

  const send = (): void => {
    const text = prompt.trim();
    if (text === '' || busy || isSending(key)) return;
    setSending(key, true);
    onError(null);
    void api
      .startRun(node.id, text)
      .then(() => {
        clearSubmittedDraft(key, prompt);
        setRevision((n) => n + 1);
        onChanged();
      })
      .catch((e: unknown) => onError(describeError(e)))
      .finally(() => setSending(key, false));
  };

  return {
    messages,
    loading,
    loaded,
    error,
    retry: () => setRevision((n) => n + 1),
    pending: busy ? pendingDeltas(live, messages) : [],
    prompt,
    setPrompt,
    sending,
    busy,
    running,
    send,
  };
}
