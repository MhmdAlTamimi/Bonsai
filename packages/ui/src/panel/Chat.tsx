import { type JSX, useEffect, useRef, useState } from 'react';
import type { DiffView, MessageView, NodeView, RunView } from '@bonsai/shared';
import { api } from '../api/client.ts';

/**
 * The conversation with this node, and the box you reply in.
 *
 * The composer sits DIRECTLY UNDER the messages on purpose. It used to be a
 * separate section below the runs list and the diff, so you typed at the bottom
 * of the panel and the answer appeared at the top of it, past three other
 * blocks -- which read as the reply landing somewhere else entirely.
 *
 * Everything here is persisted (§7 makes the conversation the primary
 * workspace, and the `message` table is what backs it), so it survives the run
 * ending, reselecting the node, and restarting the app. Live deltas merge in
 * while a run is in flight.
 */
export function Chat({
  node,
  runs,
  live,
  onChanged,
  onError,
}: {
  node: NodeView;
  runs: RunView[];
  live: string[];
  onChanged: () => void;
  onError: (message: string | null) => void;
}): JSX.Element {
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

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

  // Scroll the list itself; scrollIntoView walks up and drags the whole panel.
  useEffect(() => {
    const list = listRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [messages.length, live.length, node.status]);

  const running = node.status === 'running';

  const send = async (): Promise<void> => {
    const text = prompt.trim();
    if (text === '' || running) return;
    setSending(true);
    onError(null);
    try {
      await api.startRun(node.id, text);
      setPrompt('');
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  // Live lines the persisted transcript has not caught up with yet.
  const persistedAssistant = messages.filter((m) => m.role === 'assistant').length;
  const streamed = running ? live.slice(persistedAssistant) : [];

  // Which run each message belongs to, so a diff can be shown where it happened.
  const runsById = new Map(runs.map((r) => [r.id, r]));
  const lastMessageOfRun = new Map<string, string>();
  for (const m of messages) {
    if (m.runId !== null) lastMessageOfRun.set(m.runId, m.id);
  }

  return (
    <div className="chat">
      <div className="chat-log" ref={listRef}>
        {messages.length === 0 && streamed.length === 0 && !running && (
          <p className="muted chat-empty">
            No conversation yet. Ask for a change, or ask a question — a question that
            changes no files leaves this node conversation-only.
          </p>
        )}

        {messages.map((m) => (
          <div key={m.id}>
            <Message message={m} />
            {lastMessageOfRun.get(m.runId ?? '') === m.id && m.runId !== null && (
              <RunFooter run={runsById.get(m.runId)} />
            )}
          </div>
        ))}

        {streamed.map((text, i) => (
          <div key={`live-${i}`} className="msg assistant streaming">
            <pre>{text}</pre>
          </div>
        ))}
        {running && <div className="msg working">working…</div>}
      </div>

      <div className="composer">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline, as in any chat box.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={
            running
              ? 'The agent is working…'
              : node.writable
                ? 'Reply, ask a question, or describe a change…'
                : 'This node is frozen — you can still ask questions.'
          }
          rows={3}
          disabled={running}
          aria-label="message"
        />
        <div className="composer-row">
          <span className="hint">
            {node.writable
              ? 'Enter to send · each reply that changes files adds a commit here'
              : 'Frozen: a child committed, so replies are read-only'}
          </span>
          <button onClick={() => void send()} disabled={running || sending || prompt.trim() === ''}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function Message({ message }: { message: MessageView }): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  if (message.kind === 'tool_use') {
    const tool = message.content as { name?: string; detail?: string };
    const detail = tool.detail ?? '';
    // Commands and paths are long and the interesting part is often the end,
    // so truncating on the right hid exactly what you wanted to read. Click to
    // expand into a wrapped block; collapsed it scrolls horizontally instead.
    return (
      <div className={`msg tool ${expanded ? 'expanded' : ''}`}>
        <span className="tool-name">{tool.name ?? 'tool'}</span>
        {detail === '' ? null : (
          <button
            className="tool-detail"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'collapse' : detail}
          >
            {detail}
          </button>
        )}
      </div>
    );
  }
  const text =
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  return (
    <div className={`msg ${message.role}`}>
      <pre>{text}</pre>
    </div>
  );
}

/** What one exchange produced: its diff, expandable in place. */
function RunFooter({ run }: { run: RunView | undefined }): JSX.Element | null {
  const [diff, setDiff] = useState<DiffView | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || run === undefined || run.commitSha === null) return;
    let alive = true;
    void api
      .runDiff(run.id)
      .then((d) => alive && setDiff(d))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open, run?.id, run?.commitSha]);

  if (run === undefined) return null;

  if (run.status === 'failed' || run.status === 'cancelled') {
    return <div className="run-footer failed">{run.error ?? run.status}</div>;
  }
  if (run.commitSha === null) {
    // Not a failure: a reply that answered without editing is exactly what
    // keeps a node conversation-only, which is the whole emergent model.
    return (
      <div className="run-footer" title="This reply answered without editing files, so it added no commit.">
        answered · no commit
      </div>
    );
  }

  return (
    <div className="run-footer">
      <button className="linkish" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} {diff === null ? 'show changes' : `${diff.files.length} file(s) changed`}
      </button>
      {open && diff !== null && (
        <>
          <div className="diff-files">{diff.files.join(', ')}</div>
          <pre className="diff-patch">{diff.patch}</pre>
        </>
      )}
    </div>
  );
}
