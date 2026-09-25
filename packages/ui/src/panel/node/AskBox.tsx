import { type JSX, useEffect, useRef, useState } from 'react';
import type { AgentQuestion, NodeView } from '@bonsai/shared';

import { ApiCallError } from '../../api/ApiCallError.ts';
import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';
import {
  allAnswers,
  NOTHING_PICKED,
  pickOption,
  pickOther,
  typeOther,
  type Picked,
} from './choiceAnswers.ts';

/**
 * The agent has stopped and wants an answer.
 *
 * Two kinds of stop, one place to answer them, because they are the same event
 * to the user -- the card says Needs you and the composer gives way to this
 * box -- and differ only in what an answer is:
 *
 *   permission (D34)  may it do this? Allow, or refuse with what to do instead.
 *   choice (D42)      it asked you something. Pick, type your own, or leave
 *                     the decision to it.
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
  const sending = useSend(onAnswered, onError);
  useEffect(() => {
    onError(null);
  }, [question?.id, onError]);

  if (question === null) return null;
  return question.kind === 'choice' && question.questions !== undefined ? (
    <QuestionBox
      node={node}
      questionId={question.id}
      questions={question.questions}
      sending={sending}
    />
  ) : (
    <PermissionBox node={node} question={question} sending={sending} />
  );
}

/** One in-flight answer at a time, and one wording for "that already happened". */
function useSend(
  onAnswered: () => void,
  onError: (message: string | null) => void,
): {
  busy: boolean;
  submitted: boolean;
  send: (request: () => Promise<unknown>) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const submitting = useRef(false);
  const send = async (request: () => Promise<unknown>): Promise<void> => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    onError(null);
    try {
      await request();
      setSubmitted(true);
      onAnswered();
    } catch (e) {
      // Answered from another window, or the run ended while this was open.
      // Not a failure to retry: the tree is about to say what happened.
      if (e instanceof ApiCallError && e.status === 409) {
        onError('This was already answered or the run ended. Showing what happened.');
        setSubmitted(true);
        onAnswered();
        return;
      }
      onError(describeError(e));
      submitting.current = false;
      setBusy(false);
    }
  };
  return { busy, submitted, send };
}

type Sending = ReturnType<typeof useSend>;

/**
 * Permission (D34): two buttons, not a chat box.
 *
 * The text box belongs to the refusal. A denial's message is handed back to
 * the agent as the tool's result, so "no, edit the config instead" redirects
 * the run; an approval has no such channel, and pretending otherwise would
 * silently drop what the user typed. Hence one field, labelled for the button
 * it belongs to.
 */
function PermissionBox({
  node,
  question,
  sending,
}: {
  node: NodeView;
  question: NonNullable<NodeView['pendingQuestion']>;
  sending: Sending;
}): JSX.Element {
  const [message, setMessage] = useState('');
  const answer = (allow: boolean): Promise<void> =>
    sending.send(async () => {
      await api.answerQuestion(question.id, allow, message.trim());
      setMessage('');
    });

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
          placeholder="What should it do instead?"
          aria-label="Reason or alternative instruction (sent when refusing)"
          disabled={sending.busy}
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
      {sending.busy && (
        <p className="loading" role="status">
          {sending.submitted ? 'Answer recorded · updating' : 'Sending answer'}
        </p>
      )}
      <div className="ask-actions">
        <button onClick={() => void answer(false)} disabled={sending.busy}>
          Refuse
        </button>
        <button className="primary" onClick={() => void answer(true)} disabled={sending.busy}>
          Allow this action
        </button>
      </div>
    </div>
  );
}

/**
 * A question the agent asked (D42), shown the way it asked it.
 *
 * Options are radio buttons or checkboxes -- native controls, so keyboard and
 * screen reader behaviour come for free -- and "Other" is always there with a
 * text box, because the tool tells the agent not to offer one: the host
 * promises it. Nothing is sent until every question has an answer, and the
 * box stays until the user answers, leaves it to the agent, or stops the run.
 * There is no timeout; a question that quietly expired is the bug this
 * replaced.
 */
function QuestionBox({
  node,
  questionId,
  questions,
  sending,
}: {
  node: NodeView;
  questionId: string;
  questions: readonly AgentQuestion[];
  sending: Sending;
}): JSX.Element {
  const [picks, setPicks] = useState<Picked[]>(() => questions.map(() => NOTHING_PICKED));
  const update = (index: number, next: (picked: Picked) => Picked): void =>
    setPicks((all) => all.map((picked, i) => (i === index ? next(picked) : picked)));
  const answers = allAnswers(questions, picks);
  const submit = (): void => {
    if (answers !== null) void sending.send(() => api.answerChoices(questionId, answers));
  };

  return (
    <div className="ask ask-choice">
      <h3>Question from the agent · {node.displayName}</h3>
      {questions.map((question, index) => {
        const picked = picks[index] ?? NOTHING_PICKED;
        const group = `${questionId}-${index}`;
        const preview = question.options.find((o) => o.label === picked.focus)?.preview;
        return (
          <fieldset key={question.question} className="choice-question" disabled={sending.busy}>
            <legend>
              {question.header !== '' && <span className="chip tiny">{question.header}</span>}
              <span className="choice-text">{question.question}</span>
            </legend>
            {question.multiSelect && <p className="hint">Choose any that apply.</p>}
            <div className="choice-options">
              {question.options.map((option) => (
                <label key={option.label} className="choice-option">
                  <input
                    type={question.multiSelect ? 'checkbox' : 'radio'}
                    name={group}
                    checked={picked.selected.includes(option.label)}
                    onChange={() => update(index, (p) => pickOption(question, p, option.label))}
                  />
                  <span className="choice-label">{option.label}</span>
                  {option.description !== '' && (
                    <span className="choice-description">{option.description}</span>
                  )}
                </label>
              ))}
              <label className="choice-option choice-other">
                <input
                  type={question.multiSelect ? 'checkbox' : 'radio'}
                  name={group}
                  checked={picked.other}
                  aria-label="Other"
                  onChange={(e) => update(index, (p) => pickOther(question, p, e.target.checked))}
                />
                <span className="choice-label">Other</span>
                <input
                  type="text"
                  className="choice-other-text"
                  value={picked.otherText}
                  placeholder="Type your own answer"
                  aria-label={`Your own answer to: ${question.question}`}
                  onChange={(e) => update(index, (p) => typeOther(question, p, e.target.value))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                />
              </label>
            </div>
            {preview !== undefined && (
              <pre className="choice-preview" aria-label={`Preview of ${picked.focus ?? ''}`}>
                {preview}
              </pre>
            )}
          </fieldset>
        );
      })}
      {sending.busy && (
        <p className="loading" role="status">
          {sending.submitted ? 'Answer recorded · updating' : 'Sending answer'}
        </p>
      )}
      <div className="ask-actions">
        <button
          onClick={() => void sending.send(() => api.leaveToAgent(questionId))}
          disabled={sending.busy}
          title="The agent chooses for itself, and says in its reply what it chose."
        >
          Let the agent decide
        </button>
        <button
          className="primary"
          onClick={submit}
          disabled={sending.busy || answers === null}
          title={answers === null ? 'Answer every question first.' : undefined}
        >
          Send answer
        </button>
      </div>
    </div>
  );
}
