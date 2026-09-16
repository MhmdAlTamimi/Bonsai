import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { permissionOptions, READ_ONLY_REFUSAL } from './ClaudeSdkRunner.js';
import type { RunSpec } from './AgentRunner.js';

/**
 * Read-only has to mean read-only.
 *
 * Frozen experiments and an adopted project's master -- whose folder is the
 * user's own checkout -- were given `allowedTools` alone, on the belief that an
 * unlisted tool cannot be called. Against the real SDK that is false: the list
 * only pre-approves, and under `acceptEdits` (the app's default) the mode
 * approves writes before any list or callback is consulted. A run configured
 * that way created a file when asked, and a real read-only run on an adopted
 * master ran Bash inside the user's own folder.
 *
 * These tests pin the configuration that was verified to block it. They cannot
 * prove the SDK honours it -- scripts/probe-agent-permissions.mjs does that,
 * against the real harness -- but they stop the configuration drifting back.
 */

function spec(overrides: Partial<RunSpec>): RunSpec {
  return {
    runId: 'r',
    nodeId: 'n',
    cwd: '/tmp',
    prompt: '',
    resumeSessionId: null,
    forkSession: false,
    readOnly: false,
    successCriteria: null,
    verificationHint: null,
    model: null,
    effort: null,
    permissionMode: 'acceptEdits',
    agentEnv: null,
    ask: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function decide(
  options: ReturnType<typeof permissionOptions>,
  toolName: string,
): Promise<{ behavior: string; message?: string }> {
  assert.ok(options.canUseTool, 'a read-only run must have a callback that can say no');
  const decision = await options.canUseTool(
    toolName,
    {},
    { signal: new AbortController().signal, toolUseID: 'tool-use', requestId: 'request' },
  );
  assert.ok(decision, 'the callback answers rather than deferring');
  return decision;
}

describe('which tools a run may use', () => {
  for (const mode of ['acceptEdits', 'bypassPermissions', 'plan', 'default']) {
    test(`a read-only run ignores the project's "${mode}" mode`, () => {
      // The permissive modes exist to approve changes, and they do it before
      // the callback is asked. A read-only run makes no changes to approve.
      assert.equal(
        permissionOptions(spec({ readOnly: true, permissionMode: mode })).permissionMode,
        'default',
      );
    });
  }

  test('a read-only run refuses every tool that could change something', async () => {
    const options = permissionOptions(spec({ readOnly: true }));
    for (const tool of ['Write', 'Edit', 'NotebookEdit', 'Bash', 'Task']) {
      const decision = await decide(options, tool);
      assert.equal(decision.behavior, 'deny', `${tool} must be refused`);
      assert.equal(decision.message, READ_ONLY_REFUSAL);
    }
  });

  test('a tool nobody has heard of yet is refused, not waved through', async () => {
    // Deny by default is the only version of this that stays true when the
    // harness grows a tool. An allow-list of forbidden names would not.
    const decision = await decide(permissionOptions(spec({ readOnly: true })), 'SomeFutureTool');
    assert.equal(decision.behavior, 'deny');
  });

  test('a read-only run can still read and search', async () => {
    const options = permissionOptions(spec({ readOnly: true }));
    for (const tool of ['Read', 'Glob', 'Grep']) {
      assert.equal((await decide(options, tool)).behavior, 'allow', `${tool} must be allowed`);
      assert.ok(options.allowedTools?.includes(tool), `${tool} is pre-approved`);
    }
  });

  test('a writable run keeps the project mode and the git guard', () => {
    const options = permissionOptions(spec({ readOnly: false, permissionMode: 'acceptEdits' }));
    assert.equal(options.permissionMode, 'acceptEdits');
    assert.equal(options.allowedTools, undefined, 'no allow-list: it would hide unknown tools');
    assert.equal(options.hooks?.PreToolUse?.length, 1);
  });
});
