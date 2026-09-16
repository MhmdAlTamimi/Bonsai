import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentQuestion } from '@bonsai/shared';

import {
  allAnswers,
  answerFor,
  NOTHING_PICKED,
  pickOption,
  pickOther,
  typeOther,
} from './choiceAnswers.ts';

const single: AgentQuestion = {
  question: 'Which bucket?',
  header: 'Bucket',
  multiSelect: false,
  options: [
    { label: 'prod', description: '' },
    { label: 'staging', description: '', preview: 'gs://staging' },
  ],
};
const multi: AgentQuestion = {
  question: 'Which formats?',
  header: 'Formats',
  multiSelect: true,
  options: [
    { label: 'pdf', description: '' },
    { label: 'docx', description: '' },
    { label: 'html', description: '' },
  ],
};

describe('answering a question the agent asked', () => {
  test('nothing picked is not an answer', () => {
    assert.equal(answerFor(single, NOTHING_PICKED), '');
    assert.equal(allAnswers([single], [NOTHING_PICKED]), null);
  });

  test('a single-choice question holds exactly one answer', () => {
    let picked = pickOption(single, NOTHING_PICKED, 'prod');
    picked = pickOption(single, picked, 'staging');
    assert.deepEqual(picked.selected, ['staging']);
    assert.equal(answerFor(single, picked), 'staging');
    assert.equal(picked.focus, 'staging', 'the chosen option is the one whose preview shows');
  });

  test('typing your own answer chooses Other, and replaces the option', () => {
    let picked = pickOption(single, NOTHING_PICKED, 'prod');
    picked = typeOther(single, picked, '  gs://archive ');
    assert.equal(picked.other, true);
    assert.deepEqual(picked.selected, []);
    assert.equal(answerFor(single, picked), 'gs://archive');
  });

  test('Other chosen but left empty is not an answer', () => {
    assert.equal(answerFor(single, pickOther(single, NOTHING_PICKED, true)), '');
  });

  test('choosing an option after Other gives the option back', () => {
    let picked = typeOther(single, NOTHING_PICKED, 'mine');
    picked = pickOption(single, picked, 'prod');
    assert.equal(picked.other, false);
    assert.equal(answerFor(single, picked), 'prod');
  });

  test('a multi-select answer joins its parts the way the SDK expects', () => {
    let picked = pickOption(multi, NOTHING_PICKED, 'html');
    picked = pickOption(multi, picked, 'pdf');
    picked = typeOther(multi, picked, 'markdown');
    // Offered order, not click order, then the user's own answer last.
    assert.equal(answerFor(multi, picked), 'pdf, html, markdown');
  });

  test('ticking an option again unticks it', () => {
    let picked = pickOption(multi, NOTHING_PICKED, 'pdf');
    picked = pickOption(multi, picked, 'pdf');
    assert.equal(answerFor(multi, picked), '');
  });

  test('every question has to be answered before anything is sent', () => {
    const answered = pickOption(single, NOTHING_PICKED, 'prod');
    assert.equal(allAnswers([single, multi], [answered, NOTHING_PICKED]), null);
    assert.deepEqual(
      allAnswers([single, multi], [answered, pickOption(multi, NOTHING_PICKED, 'docx')]),
      { 'Which bucket?': 'prod', 'Which formats?': 'docx' },
    );
  });
});
