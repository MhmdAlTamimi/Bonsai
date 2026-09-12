import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection } from './connectionGate.js';
import { Settings } from '../settings.js';

/**
 * The connection gate, and the one case where it must not block.
 *
 * The gate is deliberately strict: with no working credential there is no
 * project creation, no runs and no chat, because falling back to placeholder
 * output would have a new user conclude that placeholders are what Bonsai
 * does.
 *
 * The stand-in agent is the exception, and forgetting it broke CI on the first
 * run of the browser test. A CI runner has no Claude CLI, so the gate reported
 * no_credential, the app rendered the connection screen, and a test that never
 * gets past it fails fifteen seconds later saying only that it could not find
 * the start screen.
 */
describe('the connection gate', () => {
  let dir: string;
  let settings: Settings;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bonsai-gate-'));
    settings = new Settings({
      port: 0,
      dataDir: dir,
      reposRoot: join(dir, 'repos'),
      defaultModel: null,
      defaultPermissionMode: 'acceptEdits',
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('the stand-in needs no credential, and does not go looking for one', async () => {
    const connection = new Connection(settings, true);
    const status = await connection.check();

    assert.equal(status.state, 'connected');
    assert.equal(connection.isConnected(), true);
    // Named rather than pretending to be a real credential: the menu bar shows
    // this, so a stand-in session is visibly a stand-in session.
    assert.equal(status.apiKeySource, 'stand-in');
    assert.equal(status.model, 'stand-in');
  });

  test('without the stand-in, a machine with no CLI and no key is not connected', async () => {
    // The behaviour the gate exists for, asserted next to the exception so the
    // exception cannot quietly widen into a bypass. PATH is emptied so the
    // Claude CLI cannot be found even if it is installed on this machine.
    const path = process.env['PATH'];
    process.env['PATH'] = dir;
    try {
      const status = await new Connection(settings, false).check();
      assert.equal(status.state, 'no_credential');
    } finally {
      process.env['PATH'] = path;
    }
  });
});
