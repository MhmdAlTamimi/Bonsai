import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agentModels } from './connection.js';

test('the model picker offers what Claude Code reports, by the id each row resolves to', () => {
  const models = agentModels([
    { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5' },
    {
      value: 'opus',
      resolvedModel: 'claude-opus-5-5',
      displayName: 'Opus 5.5',
      description: 'Most capable Opus',
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    // The same model under another row is offered once.
    { value: 'claude-opus-5-5', displayName: 'Opus 5.5 (pinned)', description: '' },
    // As a real Claude Code reports them: family names, a dated id.
    {
      value: 'sonnet',
      resolvedModel: 'claude-sonnet-5',
      displayName: 'Sonnet',
      description: '',
      supportedEffortLevels: ['low', 'high'],
    },
    {
      value: 'haiku',
      resolvedModel: 'claude-haiku-4-5-20251001',
      displayName: 'Haiku',
      description: 'Fastest',
    },
  ]);
  assert.deepEqual(models, [
    {
      id: 'claude-opus-5-5',
      label: 'Opus 5.5',
      description: 'Most capable Opus',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', description: null, efforts: ['low', 'high'] },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest', efforts: [] },
  ]);
});

test('effort levels are unknown, not absent, when Claude Code says nothing about effort', () => {
  assert.deepEqual(
    agentModels([
      { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus', description: '' },
    ]).map((m) => m.efforts),
    [null],
  );
});
