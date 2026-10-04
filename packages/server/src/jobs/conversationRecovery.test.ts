import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedConversation } from './conversationRecovery.js';

test('saved recovery context is empty without prior messages and strictly bounded for a single huge prompt', () => {
  assert.equal(boundedConversation([], 1000), '');
  const saved = boundedConversation(
    [{ role: 'user', kind: 'text', content: `first ${'x'.repeat(10000)} last` }],
    1000,
  );
  assert.ok(saved.length <= 1000);
  assert.match(saved, /first/);
  assert.match(saved, /last/);
  assert.match(saved, /shortened/);
});
