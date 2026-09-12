import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pendingDeltas, type Delta, type PersistedMessage } from './liveMerge.ts';

const agent = (seq: number, text: string, runId = 'r1'): Delta => ({ runId, seq, text });
const infra = (text: string, runId = 'r1'): Delta => ({ runId, seq: 0, text });
const stored = (n: number, runId: string | null = 'r1'): PersistedMessage[] =>
  Array.from({ length: n }, () => ({ role: 'assistant' as const, runId }));

test('nothing streaming is nothing to draw', () => {
  assert.deepEqual(pendingDeltas([], stored(3)), []);
});

test('with nothing persisted yet, every delta is drawn', () => {
  const live = [agent(1, 'a'), agent(2, 'b')];
  assert.deepEqual(pendingDeltas(live, []), live);
});

test('a delta the database has caught up with is dropped', () => {
  const live = [agent(1, 'a'), agent(2, 'b'), agent(3, 'c')];
  assert.deepEqual(
    pendingDeltas(live, stored(2)).map((d) => d.text),
    ['c'],
  );
});

test('once everything is persisted nothing is drawn twice', () => {
  const live = [agent(1, 'a'), agent(2, 'b')];
  assert.deepEqual(pendingDeltas(live, stored(2)), []);
});

/**
 * Bug 1. Setup output is published and never stored, so it used to shift the
 * slice index and make the agent's replies render twice.
 */
test('setup output does not push persisted replies back into view', () => {
  const live = [
    infra('setup: npm install'),
    infra('added 12 packages'),
    infra('found 0 vulnerabilities'),
    agent(1, 'I added the flag.'),
  ];
  const drawn = pendingDeltas(live, stored(1)).map((d) => d.text);
  assert.ok(!drawn.includes('I added the flag.'), 'the persisted reply must not be redrawn');
});

test('setup output itself keeps showing, having no row to replace it', () => {
  const live = [infra('setup: npm install'), infra('added 12 packages'), agent(1, 'done')];
  const drawn = pendingDeltas(live, stored(1)).map((d) => d.text);
  assert.deepEqual(drawn, ['setup: npm install', 'added 12 packages']);
});

/**
 * Bug 2. `seq` restarts per run while `messages` accumulates over the node's
 * whole life, so a naive count swallowed the start of every run after the first.
 */
test('a second run is not truncated by the first run’s messages', () => {
  const live = [agent(1, 'second run line one', 'r2'), agent(2, 'second run line two', 'r2')];
  const persisted = [...stored(5, 'r1')];
  assert.deepEqual(
    pendingDeltas(live, persisted).map((d) => d.text),
    ['second run line one', 'second run line two'],
  );
});

test('only the newest run is drawn', () => {
  const live = [agent(1, 'old', 'r1'), agent(1, 'new', 'r2')];
  assert.deepEqual(
    pendingDeltas(live, []).map((d) => d.text),
    ['new'],
  );
});

test('user and system rows do not count against the agent stream', () => {
  const live = [agent(1, 'a')];
  const persisted: PersistedMessage[] = [
    { role: 'user', runId: 'r1' },
    { role: 'system', runId: 'r1' },
  ];
  assert.deepEqual(
    pendingDeltas(live, persisted).map((d) => d.text),
    ['a'],
  );
});

test('a repeated frame is idempotent rather than doubled', () => {
  const live = [agent(1, 'a'), agent(1, 'a')];
  assert.deepEqual(pendingDeltas(live, stored(1)), []);
});
