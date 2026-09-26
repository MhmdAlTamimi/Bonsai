import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bundledClaudeCodeVersion, explainAgentError } from './claudeCode.js';

test('a model too new for the bundled Claude Code says how to fix it in Bonsai', () => {
  const raw =
    "API Error: 400 Claude Code 2.1.263 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";
  const explained = explainAgentError(raw, '2.1.263');
  assert.match(explained, /needs Claude Code 2\.1\.280 or newer/);
  assert.match(explained, /bundled with its Agent SDK \(2\.1\.263\)/);
  assert.match(explained, /not the one `claude update` updates/);
  assert.equal(explainAgentError('something else went wrong'), 'something else went wrong');
});

test('the bundled version is read from the installed Agent SDK', () => {
  assert.match(bundledClaudeCodeVersion() ?? '', /^\d+\.\d+\.\d+/);
});
