import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BUILT_IN_MODELS, pickerModels } from './models.ts';

test('with nothing reported, the picker offers the built-in models', () => {
  assert.deepEqual(pickerModels(undefined), [...BUILT_IN_MODELS]);
});

test('reported models join the built-in ones, newest of the most capable family first', () => {
  const ids = pickerModels([
    { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Balanced', efforts: ['low'] },
    { id: 'claude-opus-5', label: 'Opus 5', description: null, efforts: null },
    { id: 'claude-fable-5-1', label: 'Fable 5.1', description: null, efforts: null },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: null, efforts: null },
  ]).map((m) => m.id);
  assert.deepEqual(ids, [
    'claude-fable-5-1',
    // Not reported by an older Claude Code, still offered.
    'claude-opus-5-5',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-4-5',
  ]);
});

test('a reported entry keeps its own description and effort levels', () => {
  const sonnet = pickerModels([
    { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Balanced', efforts: ['low'] },
  ]).find((m) => m.id === 'claude-sonnet-5');
  assert.equal(sonnet?.description, 'Balanced');
  assert.deepEqual(sonnet?.efforts, ['low']);
});
