import { type JSX, useEffect, useRef, useState } from 'react';
import type { NodeView } from '@bonsai/shared';

import { ApiCallError } from '../../api/ApiCallError.ts';
import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';

/**
 * The agent has stopped and wants an answer (D34).
 *
 * Two buttons, not a chat box. The question is always the same shape — may I
 * do this thing — so an open-ended reply would be a worse interface than the
 * two answers it actually has.
 *
 * The text box belongs to the refusal. A denial's message is handed back to
 * the agent as the tool's result, so "no, edit the config instead" redirects
 * the run; an approval has no such channel, and pretending otherwise would
 * silently drop what the user typed. Hence one field, labelled for the button
 * it belongs to.
 */
export function AskBox({
  node,
  onAnswered,
  onError,
}: {
  node: NodeView;
  onAnswered: () => void;
  onError: (message: string | null) => void;
}): JSX.Element | null {
  const question = node.pendingQuestion;
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    onError(null);
  }, [question?.id, onError]);

  if (question === null) return null;

  const answer = async (allow: boolean): Promise<void> => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    onError(null);
    try {
      await api.answerQuestion(question.id, allow, message.trim());
      setMessage('');
      setSubmitted(true);
      onAnswered();
    } catch (e) {
      onError(
        e instanceof ApiCallError && e.status === 409
          ? 'This request was already answered or the run ended. Refreshing…'
          : describeError(e),
      );
      if (e instanceof ApiCallError && e.status === 409) {
        setSubmitted(true);
        onAnswered();
        return;
      }
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="ask">
      <h3>Permission requested · {node.displayName}</h3>
      {question.request ? (
        <>
          <p className="permission-action">
            <strong>{question.request.action}</strong>{' '}
            <code>{question.request.target || 'Target not supplied'}</code>
          </p>
          <details className="permission-details">
            <summary>Action details</summary>
            <pre>{question.request.details}</pre>
          </details>
        </>
      ) : (
        <p className="ask-question">{question.text}</p>
      )}
      <label className="stacked">
        Reason or alternative instruction (sent when refusing)
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What should it do instead? (sent with a refusal)"
          aria-label="Reason or alternative instruction (sent when refusing)"
          disabled={busy}
          onKeyDown={(e) => {
            // Enter refuses rather than allows, because this box exists to say
            // no. Allowing is the one-click path next to it.
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void answer(false);
            }
          }}
        />
      </label>
      {busy && <p role="status">{submitted ? 'Answer recorded · updating…' : 'Sending answer…'}</p>}
      <div className="ask-actions">
        <button onClick={() => void answer(false)} disabled={busy}>
          Refuse
        </button>
        <button className="primary" onClick={() => void answer(true)} disabled={busy}>
          Allow this action
        </button>
      </div>
    </div>
  );
}
