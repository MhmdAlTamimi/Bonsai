import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DiagnosticsView } from '@bonsai/shared';
import { diagnosticReport } from './diagnosticPrivacy.js';

test('diagnostics omit free-form errors/names/log content and redact credentials in metadata', () => {
  const input: DiagnosticsView = {
    generatedAt: '2026-09-14T00:00:00.000Z',
    app: { node: 'v22', platform: 'linux', arch: 'x64' },
    paths: {
      dataDir: '/tmp/private-secret',
      reposRoot: '/tmp/sk-ant-testsecret',
      logDir: '/tmp/logs',
    },
    agent: {
      authMode: 'api_key',
      hasStoredApiKey: true,
      model: null,
      effort: null,
      permissionMode: 'default',
      standIn: false,
      claudeCodeVersion: null,
    },
    connection: {
      state: 'error',
      apiKeySource: null,
      model: null,
      message: 'user prompt and secret',
    },
    counts: { projects: 1, nodes: 1, runs: 0, running: 0 },
    node: {
      id: 'node',
      displayName: 'private experiment',
      status: 'new',
      writable: true,
      frozenReason: null,
      runs: [
        {
          id: 'run',
          nodeId: 'node',
          status: 'failed',
          endReason: 'failed',
          stoppedBackground: 0,
          change: null,
          startedAt: '2026-09-14T00:00:00.000Z',
          endedAt: null,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          model: null,
          apiKeySource: null,
          commitSha: null,
          toolsOffered: null,
          toolCalls: 0,
          durationMs: null,
          error: 'run output private-secret',
        },
      ],
    },
    log: [
      'raw output secret',
      JSON.stringify({
        t: '2026-09-14T00:00:00.000Z',
        level: 'error',
        event: 'run.failed',
        error: 'prompt and secret',
        tokens: 12,
        done: false,
      }),
    ],
  };
  const result = diagnosticReport(input, ['private-secret']);
  const text = JSON.stringify(result);
  for (const secret of [
    'private-secret',
    'sk-ant-testsecret',
    'private experiment',
    'prompt and secret',
    'raw output',
  ])
    assert.ok(!text.includes(secret));
  assert.equal(result.connection.message, null);
  assert.equal(result.node?.displayName, '[omitted]');
  assert.equal(result.node?.runs[0]?.error, null);
  assert.deepEqual(JSON.parse(result.log[0]!), {
    t: '2026-09-14T00:00:00.000Z',
    level: 'error',
    event: 'run.failed',
    tokens: 12,
    done: false,
  });
  assert.equal(input.node?.displayName, 'private experiment', 'source remains untouched');
});
