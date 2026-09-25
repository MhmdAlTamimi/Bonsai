import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASK_USER_TOOL,
  NO_ONE_TO_ASK,
  parseQuestions,
  permissionOptions,
  READ_ONLY_REFUSAL,
} from './ClaudeSdkRunner.js';
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
    readOnly: false,
    successCriteria: null,
    verificationHint: null,
    model: null,
    effort: null,
    permissionMode: 'acceptEdits',
    agentEnv: null,
    ask: null,
    askChoices: null,
    signal: new AbortController().signal,
    finishNow: new AbortController().signal,
    onActivity: () => undefined,
    backgroundLeftovers: () => Promise.resolve([]),
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

/**
 * D42: the agent's questions reach the user, whatever the mode.
 *
 * The reported bug, pinned: under `acceptEdits` the callback approved the
 * question with no answers, the tool returned at once, and the agent wrote
 * "The user hasn't answered yet -- I'll wait" into a run that then ended. The
 * SDK's contract is that answers travel back as `answers` in the returned
 * input; these tests hold Bonsai to it.
 */
describe('a question from the agent', () => {
  const QUESTIONS = [
    {
      question: 'Which bucket should I read from?',
      header: 'Bucket',
      multiSelect: false,
      options: [
        { label: 'gs://docs-prod', description: 'Production documents' },
        { label: 'gs://docs-staging', description: 'Staging copy', preview: 'gs://docs-staging/*' },
      ],
    },
  ];
  const INPUT = { questions: QUESTIONS };

  async function callback(
    options: ReturnType<typeof permissionOptions>,
    input: Record<string, unknown> = INPUT,
    signal = new AbortController().signal,
  ): Promise<Record<string, unknown>> {
    assert.ok(options.canUseTool);
    const result = await options.canUseTool(ASK_USER_TOOL, input, {
      signal,
      toolUseID: 'tool-use',
      requestId: 'request',
    });
    assert.ok(result);
    return result;
  }

  for (const [label, overrides] of [
    ['acceptEdits', { permissionMode: 'acceptEdits' }],
    ['bypassPermissions', { permissionMode: 'bypassPermissions' }],
    ['plan', { permissionMode: 'plan' }],
    ['default', { permissionMode: 'default' }],
    ['a read-only run', { readOnly: true }],
  ] as const) {
    test(`is put to the user under ${label}, and the answer goes back in the input`, async () => {
      const asked: unknown[] = [];
      const result = await callback(
        permissionOptions(
          spec({
            ...overrides,
            askChoices: (request) => {
              asked.push(request);
              return Promise.resolve({
                answered: true,
                answers: { 'Which bucket should I read from?': 'gs://docs-prod' },
              });
            },
          }),
        ),
      );
      assert.deepEqual(asked, [{ questions: QUESTIONS }], 'the user saw exactly what was asked');
      assert.equal(result['behavior'], 'allow');
      assert.deepEqual(result['updatedInput'], {
        questions: QUESTIONS,
        answers: { 'Which bucket should I read from?': 'gs://docs-prod' },
      });
    });
  }

  test('left to the agent, it is told to decide and say what it assumed', async () => {
    const result = await callback(
      permissionOptions(
        spec({
          askChoices: () => Promise.resolve({ answered: false, reason: 'decide yourself' }),
        }),
      ),
    );
    assert.deepEqual(result, { behavior: 'deny', message: 'decide yourself' });
  });

  test('with nobody to ask, it is never answered on the user’s behalf', async () => {
    // The old bug in its purest form: approving with no answers. Without a
    // pipeline there is no user, and the agent must be told that plainly.
    const result = await callback(permissionOptions(spec({ askChoices: null })));
    assert.deepEqual(result, { behavior: 'deny', message: NO_ONE_TO_ASK });
  });

  test('a stopped run does not put the question to anyone', async () => {
    const controller = new AbortController();
    controller.abort();
    let asked = false;
    const result = await callback(
      permissionOptions(
        spec({
          askChoices: () => {
            asked = true;
            return Promise.resolve({ answered: true, answers: {} });
          },
        }),
      ),
      INPUT,
      controller.signal,
    );
    assert.equal(asked, false);
    assert.equal(result['behavior'], 'deny');
  });

  test('a malformed question goes back to the agent to fix, not to the panel', async () => {
    let asked = false;
    const options = permissionOptions(
      spec({
        askChoices: () => {
          asked = true;
          return Promise.resolve({ answered: true, answers: {} });
        },
      }),
    );
    for (const bad of [
      {},
      { questions: [] },
      { questions: [{ question: 'Only one option?', header: 'x', options: [{ label: 'a' }] }] },
      {
        questions: [
          { question: 'Same', header: 'a', options: [{ label: 'x' }, { label: 'y' }] },
          { question: 'Same', header: 'b', options: [{ label: 'x' }, { label: 'y' }] },
        ],
      },
    ]) {
      assert.equal((await callback(options, bad))['behavior'], 'deny');
    }
    assert.equal(asked, false);
  });

  test('parsing keeps the preview and fills a missing description', () => {
    const parsed = parseQuestions({
      questions: [
        {
          question: 'Pick',
          header: 'H',
          multiSelect: true,
          options: [{ label: 'a', preview: 'code' }, { label: 'b' }],
        },
      ],
    });
    assert.deepEqual(parsed, [
      {
        question: 'Pick',
        header: 'H',
        multiSelect: true,
        options: [
          { label: 'a', description: '', preview: 'code' },
          { label: 'b', description: '' },
        ],
      },
    ]);
  });
});

for (const mode of ['default', 'plan', 'acceptEdits', 'bypassPermissions']) {
  test(`writable ${mode} supplies the expected SDK bypass opt-in`, () => {
    const options = permissionOptions(spec({ permissionMode: mode }));
    assert.equal(options.permissionMode, mode);
    assert.equal(options.allowDangerouslySkipPermissions === true, mode === 'bypassPermissions');
    const readOnly = permissionOptions(spec({ permissionMode: mode, readOnly: true }));
    assert.notEqual(readOnly.allowDangerouslySkipPermissions, true);
  });
}

for (const mode of ['acceptEdits', 'bypassPermissions', 'plan']) {
  test(`${mode} callback approves ordinary requests; SDK mode restrictions are separate`, async () => {
    const options = permissionOptions(spec({ permissionMode: mode }));
    assert.equal((await decide(options, 'Bash')).behavior, 'allow');
  });
}
test('default mode routes mutating requests through the user gate', async () => {
  const calls: string[] = [];
  const options = permissionOptions(
    spec({
      permissionMode: 'default',
      ask: (request) => {
        calls.push(request.toolName);
        return Promise.resolve({ allow: false, reason: 'declined' });
      },
    }),
  );
  assert.equal((await decide(options, 'Read')).behavior, 'allow');
  assert.equal((await decide(options, 'Bash')).behavior, 'deny');
  assert.deepEqual(calls, ['Bash']);
});
