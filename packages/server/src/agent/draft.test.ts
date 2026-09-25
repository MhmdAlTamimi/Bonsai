import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { ClaudeSdkRunner, draftOptions } from './ClaudeSdkRunner.js';
import type { DraftRequest } from './AgentRunner.js';

/**
 * Drafting a reference is one model turn that can only write text. These pin
 * the configuration that makes that true, because "it has no tools" is a
 * claim the interface relies on and nothing else would notice it breaking.
 */
const request = (overrides: Partial<DraftRequest> = {}): DraftRequest => ({
  instructions: 'Write a reference.',
  input: '## Conversation\n\nUser: try redis',
  model: 'claude-test',
  agentEnv: null,
  signal: new AbortController().signal,
  ...overrides,
});

const result = (fields: Record<string, unknown>): SDKMessage =>
  ({ type: 'result', session_id: 's', uuid: 'u', ...fields }) as unknown as SDKMessage;

/** The messages a one-shot query would yield, in order. */
const stream = (...messages: SDKMessage[]): AsyncIterable<SDKMessage> => ({
  [Symbol.asyncIterator]: () => {
    let next = 0;
    return {
      next: () =>
        Promise.resolve(
          next < messages.length
            ? { value: messages[next++]!, done: false as const }
            : { value: undefined, done: true as const },
        ),
    };
  },
});

describe('drafting a reference', () => {
  test('is configured so it cannot act', async () => {
    const options = draftOptions(request(), new AbortController());
    assert.deepEqual(options.tools, [], 'no built-in tools at all');
    assert.deepEqual(
      options.settingSources,
      [],
      'nothing loaded from disk: no MCP, skills or hooks',
    );
    assert.equal(options.maxTurns, 1);
    assert.equal(options.persistSession, false, 'leaves no session to resume');
    assert.equal(options.cwd, tmpdir());
    assert.equal(options.systemPrompt, 'Write a reference.');
    assert.equal(options.model, 'claude-test');
    const decision = await options.canUseTool!('Bash', {}, {
      signal: new AbortController().signal,
    } as never);
    assert.equal(decision?.behavior, 'deny');
  });

  test('returns what the model wrote, and sends the input as the prompt', async () => {
    let sent: { prompt: string; options: Options } | null = null;
    const runner = new ClaudeSdkRunner(undefined, undefined, (params) => {
      sent = params;
      return stream(result({ subtype: 'success', result: '  ## Smoke test\n\nRun npm test.  ' }));
    });
    assert.equal(await runner.draft(request()), '## Smoke test\n\nRun npm test.');
    assert.equal(sent!.prompt, '## Conversation\n\nUser: try redis');
  });

  test('a failed turn is an error, not an empty draft', async () => {
    const runner = new ClaudeSdkRunner(undefined, undefined, () =>
      stream(result({ subtype: 'error_during_execution', errors: ['overloaded'] })),
    );
    await assert.rejects(runner.draft(request()), /overloaded/);
  });

  test('stopping the request stops the model call', async () => {
    const stop = new AbortController();
    let aborted = false;
    const runner = new ClaudeSdkRunner(undefined, undefined, ({ options }) => {
      options.abortController!.signal.addEventListener('abort', () => (aborted = true));
      stop.abort();
      return stream(result({ subtype: 'success', result: 'x' }));
    });
    await runner.draft(request({ signal: stop.signal }));
    assert.equal(aborted, true);
  });
});
