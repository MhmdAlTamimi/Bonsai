import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { describeTool, formatElapsed, since, waitingHeadline } from './activity.ts';

describe('what a run is doing, in words', () => {
  test('a tool reads as a verb and its subject', () => {
    const at = '2026-09-16T12:00:00.000Z';
    assert.equal(
      describeTool({ name: 'Bash', detail: 'uv sync', startedAt: at }),
      'Running uv sync',
    );
    assert.equal(
      describeTool({ name: 'Setup', detail: 'npm install', startedAt: at }),
      'Setting up npm install',
    );
    assert.equal(describeTool({ name: 'Read', detail: '', startedAt: at }), 'Reading');
    // A tool this list does not know still reads as something.
    assert.equal(
      describeTool({ name: 'mcp__db__query', detail: 'x', startedAt: at }),
      'Using mcp__db__query x',
    );
  });

  test('elapsed time stays short at every scale', () => {
    assert.equal(formatElapsed(8_400), '8s');
    assert.equal(formatElapsed(245_000), '4m 05s');
    assert.equal(formatElapsed(3_720_000), '1h 02m');
    // A clock slightly behind the server is not a negative duration.
    assert.equal(formatElapsed(-500), '0s');
    assert.equal(
      since('2026-09-16T12:00:00.000Z', Date.parse('2026-09-16T12:01:12.000Z')),
      '1m 12s',
    );
    assert.equal(since('not a date', 0), '');
  });

  test('waiting says how many jobs', () => {
    const job = { id: 'a', description: 'x', tracked: true, startedAt: '' };
    assert.equal(waitingHeadline([job]), 'Waiting for 1 background job');
    assert.equal(waitingHeadline([job, { ...job, id: 'b' }]), 'Waiting for 2 background jobs');
  });
});
