import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseAnswer } from './answers.js';
import type { StoredQuestion } from '../db/store.js';

/**
 * An answer means what the stored question says it can mean, and nothing else.
 *
 * The two kinds of question take different answers, and the dangerous failure
 * is a quiet reinterpretation: "allow" sent to a question the agent asked
 * turning into an empty answer, or a half-answered question releasing a run
 * with a blank for the part nobody filled in.
 */
const base = { id: 'q', node_id: 'n', run_id: 'r', text: 't', answered_at: null };
const permission: StoredQuestion = { ...base, kind: 'permission' };
const choice: StoredQuestion = {
  ...base,
  kind: 'choice',
  questions: [
    {
      question: 'Which bucket?',
      header: 'Bucket',
      multiSelect: false,
      options: [
        { label: 'a', description: '' },
        { label: 'b', description: '' },
      ],
    },
    {
      question: 'Which formats?',
      header: 'Formats',
      multiSelect: true,
      options: [
        { label: 'pdf', description: '' },
        { label: 'docx', description: '' },
      ],
    },
  ],
};

const status = (fn: () => unknown): number => {
  try {
    fn();
  } catch (error) {
    return (error as { status: number }).status;
  }
  return 200;
};

describe('answering a parked question', () => {
  test('a permission question takes allow, and a refusal keeps its words', () => {
    assert.deepEqual(parseAnswer(permission, { allow: true }), {
      kind: 'permission',
      decision: { allow: true },
    });
    assert.deepEqual(parseAnswer(permission, { allow: false, message: ' use make ' }), {
      kind: 'permission',
      decision: { allow: false, reason: 'use make' },
    });
    assert.equal(
      status(() => parseAnswer(permission, {})),
      400,
    );
    assert.equal(
      status(() => parseAnswer(permission, { answers: { x: 'y' } })),
      400,
    );
  });

  test('a question the agent asked takes an answer to every question', () => {
    assert.deepEqual(
      parseAnswer(choice, { answers: { 'Which bucket?': ' b ', 'Which formats?': 'pdf, docx' } }),
      { kind: 'choice', answers: { 'Which bucket?': 'b', 'Which formats?': 'pdf, docx' } },
    );
  });

  test('a half-answered question is refused, not sent with a blank', () => {
    assert.equal(
      status(() => parseAnswer(choice, { answers: { 'Which bucket?': 'b' } })),
      400,
    );
    assert.equal(
      status(() =>
        parseAnswer(choice, { answers: { 'Which bucket?': 'b', 'Which formats?': '  ' } }),
      ),
      400,
    );
  });

  test('answers to a different question are refused', () => {
    assert.equal(
      status(() =>
        parseAnswer(choice, {
          answers: { 'Which bucket?': 'b', 'Which formats?': 'pdf', 'Something else?': 'x' },
        }),
      ),
      400,
    );
  });

  test('it can be left to the agent, but not answered and left at once', () => {
    assert.deepEqual(parseAnswer(choice, { agentDecides: true }), { kind: 'leftToAgent' });
    assert.equal(
      status(() =>
        parseAnswer(choice, {
          agentDecides: true,
          answers: { 'Which bucket?': 'b', 'Which formats?': 'pdf' },
        }),
      ),
      400,
    );
  });

  test('allow is not an answer to a question the agent asked', () => {
    assert.equal(
      status(() => parseAnswer(choice, { allow: true })),
      400,
    );
  });
});
