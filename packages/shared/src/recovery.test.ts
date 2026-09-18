import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recoveryCause } from './recovery.ts';

test('uncommitted work is explained by how the last run ended', () => {
  assert.equal(recoveryCause({ endReason: 'stopped' }), 'stopped');
  assert.equal(recoveryCause({ endReason: 'failed' }), 'failed');
  assert.equal(recoveryCause({ endReason: 'app_closed' }), 'app_closed');
  // Not an interruption: the run ended, and something changed files afterwards.
  assert.equal(recoveryCause({ endReason: 'finished' }), 'changed_after_finish');
  assert.equal(recoveryCause(undefined), 'changed_after_finish');
});
