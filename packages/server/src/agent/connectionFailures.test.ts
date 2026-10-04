import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import type { SDKMessage, query } from '@anthropic-ai/claude-agent-sdk';
import { probeConnection } from './connection.js';
import { bundledClaudeCodeCommand } from './claudeCode.js';
import { ApiRetryGuard } from './apiFailures.js';
import { credentialEnvironment } from './credentials.js';

test('connection probes classify terminal SDK frames promptly instead of reporting a timeout', async () => {
  for (const [error, status, state] of [
    ['authentication_failed', 401, 'no_credential'],
    ['billing_error', 400, 'error'],
    ['rate_limit', 429, 'rate_limited'],
  ] as const) {
    let aborted = false;
    const start = ((params: Parameters<typeof query>[0]) =>
      (function* () {
        params.options!.abortController!.signal.addEventListener('abort', () => {
          aborted = true;
        });
        yield {
          type: 'system',
          subtype: 'api_retry',
          attempt: 1,
          max_retries: 10,
          retry_delay_ms: 1000,
          error_status: status,
          error,
          uuid: '00000000-0000-4000-8000-000000000000',
          session_id: 'fixture',
        } as SDKMessage;
        assert.fail('probe must not wait for another retry');
      })()) as unknown as typeof query;
    const result = await probeConnection({ model: null, apiKey: 'fixture', timeoutMs: 100 }, start);
    assert.equal(result.state, state);
    assert.equal(aborted, true);
    assert.doesNotMatch(result.message ?? '', /timed out|offline/);
  }
});
test('a stalled SDK retry is cancelled by the retry deadline even without another frame', async () => {
  const controller = new AbortController();
  const guard = new ApiRetryGuard(controller, 20);
  const stopped = new Promise<void>((resolve) =>
    controller.signal.addEventListener('abort', () => resolve(), { once: true }),
  );
  guard.retry({
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 1,
    error_status: 500,
    error: 'server_error',
    uuid: '00000000-0000-4000-8000-000000000000',
    session_id: 'fixture',
  });
  const keepAlive = setTimeout(() => assert.fail('retry failed to stop'), 200);
  try {
    await stopped;
    assert.match(guard.error ?? '', /partial work is preserved/);
  } finally {
    clearTimeout(keepAlive);
    guard.dispose();
  }
});
test('the subscription CLI is installed with the SDK and needs no command on PATH', () => {
  assert.equal(existsSync(bundledClaudeCodeCommand().file), true);
});

test('subscription mode clears inherited API credentials and key mode clears inherited subscription tokens', () => {
  const inherited = {
    ANTHROPIC_API_KEY: 'key-canary',
    ANTHROPIC_AUTH_TOKEN: 'auth-canary',
    CLAUDE_CODE_OAUTH_TOKEN: 'subscription-canary',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:fixture',
  };
  const subscription = { ...inherited, ...credentialEnvironment(null) };
  assert.equal(subscription.ANTHROPIC_API_KEY, '');
  assert.equal(subscription.ANTHROPIC_AUTH_TOKEN, '');
  assert.equal(subscription.CLAUDE_CODE_OAUTH_TOKEN, 'subscription-canary');
  const api = { ...inherited, ...credentialEnvironment('selected-canary') };
  assert.equal(api.ANTHROPIC_API_KEY, 'selected-canary');
  assert.equal(api.CLAUDE_CODE_OAUTH_TOKEN, '');
  assert.equal(api.ANTHROPIC_BASE_URL, inherited.ANTHROPIC_BASE_URL);
});
