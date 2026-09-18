import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { RunView } from '@bonsai/shared';

import { recoveryWords } from './recoveryWords.ts';

const run = (overrides: Partial<RunView>): RunView => ({
  id: 'r',
  nodeId: 'n',
  status: 'done',
  endReason: 'finished',
  stoppedBackground: 0,
  change: null,
  startedAt: '2026-09-16T12:00:00.000Z',
  endedAt: '2026-09-16T12:05:00.000Z',
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  model: null,
  apiKeySource: null,
  commitSha: null,
  toolsOffered: null,
  toolCalls: 0,
  durationMs: null,
  error: null,
  ...overrides,
});

describe('the recovery notice says what happened', () => {
  test('a run you stopped says so, and offers to continue from its files', () => {
    const words = recoveryWords({
      runs: [run({ status: 'cancelled', endReason: 'stopped', stoppedBackground: 1 })],
      interrupted: true,
      changedFiles: 3,
      isYourFolder: false,
    });
    assert.equal(words.headline, 'You stopped this run.');
    assert.deepEqual(words.details, ['1 background job was still running and was stopped.']);
    assert.equal(words.files, '3 files not yet saved in any result.');
    assert.equal(words.continueLabel, 'Continue from these files');
    assert.equal(words.leaveLabel, 'Leave uncommitted');
    assert.equal(words.discardLabel, 'Discard…');
  });

  test('a failure shows its message; an app exit is not called a failure', () => {
    const failed = recoveryWords({
      runs: [run({ status: 'failed', endReason: 'failed', error: 'rate limited' })],
      interrupted: true,
      changedFiles: 1,
      isYourFolder: false,
    });
    assert.equal(failed.headline, 'The run failed.');
    assert.deepEqual(failed.details, ['rate limited']);

    const closed = recoveryWords({
      runs: [run({ status: 'failed', endReason: 'app_closed' })],
      interrupted: true,
      changedFiles: 1,
      isYourFolder: false,
    });
    assert.equal(closed.headline, 'Bonsai closed while this run was working.');
    assert.deepEqual(closed.details, []);
  });

  test('files changed after a finished run are never called an interruption', () => {
    const words = recoveryWords({
      runs: [run({})],
      interrupted: false,
      changedFiles: 2,
      isYourFolder: false,
    });
    assert.equal(words.headline, 'Files changed after this run finished.');
    assert.doesNotMatch(JSON.stringify(words), /interrupt|stopped/i);
    assert.equal(words.continueLabel, 'Ask the agent to review them');
    assert.equal(words.leaveLabel, null, 'already left: there is nothing more to leave');
  });

  test('left uncommitted, a stopped run still says where the files came from', () => {
    const words = recoveryWords({
      runs: [run({ status: 'cancelled', endReason: 'stopped' })],
      interrupted: false,
      changedFiles: 1,
      isYourFolder: false,
    });
    assert.equal(words.headline, 'Work from the run you stopped is still uncommitted.');
    assert.equal(words.files, '1 file not yet saved in any result.');
  });

  test('nothing written: run it again or dismiss, and nothing to discard', () => {
    const words = recoveryWords({
      runs: [run({ status: 'cancelled', endReason: 'stopped' })],
      interrupted: true,
      changedFiles: 0,
      isYourFolder: true,
    });
    assert.equal(words.files, 'Nothing was written — this experiment only reads your folder.');
    assert.equal(words.continueLabel, 'Run it again');
    assert.equal(words.leaveLabel, 'Dismiss');
    assert.equal(words.discardLabel, null);
  });
});
