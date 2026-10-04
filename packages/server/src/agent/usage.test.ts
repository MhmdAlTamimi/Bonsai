import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk';
import { openInMemory } from '../db/open.js';
import { SdkSessionStore } from '../db/sdkSessionStore.js';
import { sessionUsage } from './usage.js';

const models = (turns: number): Record<string, ModelUsage> => ({
  haiku: {
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadInputTokens: 10,
    cacheCreationInputTokens: 20,
  } as ModelUsage,
  opus: {
    inputTokens: 1000 * turns,
    outputTokens: 100 * turns,
    cacheReadInputTokens: 50 * turns,
    cacheCreationInputTokens: 25 * turns,
  } as ModelUsage,
});
test('resumed totals subtract one frozen native baseline, including sidechains and cache tokens', async () => {
  const db = openInMemory();
  try {
    const store = new SdkSessionStore(db);
    await store.append({ sessionId: 'owned', projectKey: 'old-cwd' }, [
      { type: 'cost-state', totalCostUSD: 0.0135, modelUsage: models(2) },
    ]);
    const usage = await sessionUsage(store, 'owned', 'moved-cwd');
    const third = usage.result({ total_cost_usd: 0.0195, usage: {}, modelUsage: models(3) });
    assert.ok(Math.abs(third.costUsd - 0.006) < 1e-9);
    assert.deepEqual(
      [
        third.inputTokens,
        third.outputTokens,
        third.cacheReadTokens,
        third.cacheCreationTokens,
        third.model,
        third.usageStatus,
      ],
      [1000, 100, 50, 25, 'opus', 'recorded'],
    );
    // A second result in the SAME request replaces, rather than adds to, its first report.
    await store.append({ sessionId: 'owned', projectKey: 'moved-cwd' }, [
      { type: 'cost-state', totalCostUSD: 0.0195, modelUsage: models(3) },
    ]);
    const fourth = usage.result({ total_cost_usd: 0.0255, usage: {}, modelUsage: models(4) });
    assert.ok(Math.abs(fourth.costUsd - 0.012) < 1e-9);
    assert.equal(fourth.inputTokens, 2000);
    assert.deepEqual(
      usage.result({ total_cost_usd: 0.0255, usage: {}, modelUsage: models(4) }),
      fourth,
      'duplicate frame is idempotent',
    );
  } finally {
    db.close();
  }
});

test('a native fork without cost-state starts its own accounting at zero', async () => {
  const db = openInMemory();
  try {
    const store = new SdkSessionStore(db);
    await store.append({ sessionId: 'fork', projectKey: 'cwd' }, [
      { type: 'user', uuid: 'inherited' },
    ]);
    const usage = await sessionUsage(store, 'fork', 'cwd');
    assert.equal(
      usage.result({ total_cost_usd: 0.006, usage: {}, modelUsage: { opus: models(1)['opus']! } })
        .costUsd,
      0.006,
    );
  } finally {
    db.close();
  }
});

test('a missing report, changed cost-state format or counter reset cannot claim zero spend', async () => {
  const db = openInMemory();
  try {
    const store = new SdkSessionStore(db);
    for (const state of [
      { type: 'cost-state', totalCostUSD: 'new-format', modelUsage: {} },
      { type: 'cost-state', totalCostUSD: 1, modelUsage: {} },
      { type: 'cost-state', totalCostUSD: Number.NaN, modelUsage: {} },
    ]) {
      await store.append({ sessionId: 'unknown', projectKey: 'cwd' }, [state]);
      const usage = await sessionUsage(store, 'unknown', 'cwd');
      assert.equal(usage.result({ total_cost_usd: 0.5, usage: {} }).usageStatus, 'unknown');
    }
    const usage = await sessionUsage(undefined, null, 'cwd');
    assert.equal(
      usage.result({ total_cost_usd: undefined as unknown as number, usage: {} }).usageStatus,
      'unknown',
    );
  } finally {
    db.close();
  }
});
