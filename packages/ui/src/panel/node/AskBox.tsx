import { type JSX, useState } from 'react';
import type { NodeView } from '@bonsai/shared';

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

  if (question === null) return null;

  const answer = async (allow: boolean): Promise<void> => {
    setBusy(true);
    onError(null);
    try {
      await api.answerQuestion(question.id, allow, message.trim());
      setMessage('');
      onAnswered();
    } catch (e) {
      onError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ask">
      <p className="ask-question">{question.text}</p>
      <input
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="What should it do instead? (sent with a refusal)"
        aria-label="what to do instead"
        disabled={busy}
        onKeyDown={(e) => {
          // Enter refuses rather than allows, because this box exists to say
          // no. Allowing is the one-click path next to it.
          if (e.key === 'Enter') {
            e.preventDefault();
            void answer(false);
          }
        }}
      />
      <div className="ask-actions">
        <button onClick={() => void answer(false)} disabled={busy}>
          Refuse
        </button>
        <button className="primary" onClick={() => void answer(true)} disabled={busy}>
          Allow
        </button>
      </div>
    </div>
  );
}
