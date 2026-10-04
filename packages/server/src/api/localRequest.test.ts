import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalRequest } from './localRequest.js';

test('browser mutations require the same origin, including its port and protocol', () => {
  const host = 'localhost:8787';
  assert.doesNotThrow(() => assertLocalRequest({ host, origin: 'http://localhost:8787' }, 'POST'));
  assert.doesNotThrow(() => assertLocalRequest({ host }, 'POST'));
  for (const origin of [
    'http://localhost:9999',
    'https://localhost:8787',
    'null',
    'http://evil.test',
  ])
    assert.throws(() => assertLocalRequest({ host, origin }, 'POST'), /local applications/);
  assert.throws(() => assertLocalRequest({ host: 'evil.test:8787' }), /local applications/);
  assert.doesNotThrow(() =>
    assertLocalRequest({ host, origin: 'http://localhost:5173' }, 'POST', [
      'http://localhost:5173',
    ]),
  );
});
