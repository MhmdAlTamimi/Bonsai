import { type JSX, useEffect, useRef, useState } from 'react';
import type { MessageView, NodeView } from '@bonsai/shared';
import { api } from '../api/client.ts';

/**
 * The node's conversation. PRD §7 makes this the panel's primary workspace, and
 * D22 keeps CONTEXT.md as a separate human-readable record rather than this.
 *
 * It is persisted, not a live buffer. Streaming deltas alone vanished the moment
 * a run finished and the panel switched out of its `running` state, so the
 * conversation you had just watched disappeared. Every message is written to
 * the database as it arrives (that is what the `message` table is for), so this
 * survives the run ending, reselecting the node, and restarting the app.
 *
 * Live deltas are still merged in while a run is in flight, so output appears
 * as it is produced rather than only at the end.
 */
export function Conversation({
  node,
  live,
}: {
  node: NodeView;
  live: string[];
}): JSX.Element {
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  // Refetch when the node changes and whenever its status does -- a run
  // finishing is exactly when new messages have landed.
  useEffect(() => {
    let live = true;
    setLoading(true);
    void api
      .messages(node.id)
      .then((m) => {
        if (live) {
          setMessages(m);
          setLoading(false);
        }
      })
      .catch(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [node.id, node.status]);

  // Scroll the list itself rather than calling scrollIntoView, which walks up
  // to the nearest scrollable ancestor and drags the whole panel with it.
  useEffect(() => {
    const list = listRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [messages.length, live.length]);

  // While running, the persisted messages may lag the stream by a moment; show
  // whichever is longer rather than double-printing the overlap.
  const streamed = node.status === 'running' ? live.slice(countAssistantLines(messages)) : [];

  if (loading && messages.length === 0) {
    return <p className="muted">loading conversation…</p>;
  }

  if (messages.length === 0 && streamed.length === 0) {
    return <p className="muted">No conversation yet.</p>;
  }

  return (
    <div className="conversation" ref={listRef}>
      {messages.map((m) => (
        <Message key={m.id} message={m} />
      ))}
      {streamed.map((text, i) => (
        <div key={`live-${i}`} className="msg assistant streaming">
          <pre>{text}</pre>
        </div>
      ))}
      {node.status === 'running' && <div className="msg assistant working">working…</div>}
    </div>
  );
}

function Message({ message }: { message: MessageView }): JSX.Element {
  if (message.kind === 'tool_use') {
    const tool = message.content as { name?: string; detail?: string };
    return (
      <div className="msg tool">
        <span className="tool-name">{tool.name ?? 'tool'}</span>
        {tool.detail ? <span className="tool-detail">{tool.detail}</span> : null}
      </div>
    );
  }

  const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  return (
    <div className={`msg ${message.role}`}>
      <pre>{text}</pre>
    </div>
  );
}

/** How many assistant lines are already persisted, so live output is not doubled. */
function countAssistantLines(messages: readonly MessageView[]): number {
  return messages.filter((m) => m.role === 'assistant').length;
}
