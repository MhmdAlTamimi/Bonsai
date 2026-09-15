import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { appendDelta, MAX_DELTAS_PER_NODE } from './deltaBuffer.ts';
import { pendingDeltas, type Delta } from '../panel/chat/liveMerge.ts';

const text = (runId: string, seq: number, body: string): Delta => ({ runId, seq, text: body });

describe('the live delta buffer', () => {
  test('a repeated numbered frame is ignored, and the array identity is kept', () => {
    const one = appendDelta([], text('r1', 1, 'hello'));
    const again = appendDelta(one, text('r1', 1, 'hello'));
    assert.equal(again, one);
  });

  test('consecutive unpersisted chunks from one run merge into a single entry', () => {
    let buffer: readonly Delta[] = [];
    for (const chunk of ['npm ', 'install', '\nadded 1 package'])
      buffer = appendDelta(buffer, text('r1', 0, chunk));
    assert.equal(buffer.length, 1);
    assert.equal(buffer[0]?.text, 'npm install\nadded 1 package');
  });

  test('a tool frame is never merged into the text before it', () => {
    let buffer = appendDelta([], text('r1', 0, 'setup output'));
    buffer = appendDelta(buffer, {
      runId: 'r1',
      seq: 2,
      text: 'Read: a.ts',
      tool: { name: 'Read', detail: 'a.ts' },
    });
    assert.equal(buffer.length, 2);
    assert.equal(buffer[1]?.tool?.name, 'Read');
  });

  test('unpersisted chunks from different runs stay apart', () => {
    let buffer = appendDelta([], text('r1', 0, 'first run'));
    buffer = appendDelta(buffer, text('r2', 0, 'second run'));
    assert.deepEqual(
      buffer.map((d) => d.runId),
      ['r1', 'r2'],
    );
  });

  test('the buffer is bounded, and drops the oldest frames first', () => {
    let buffer: readonly Delta[] = [];
    for (let seq = 1; seq <= MAX_DELTAS_PER_NODE + 50; seq += 1)
      buffer = appendDelta(buffer, text('r1', seq, `line ${seq}`));
    assert.equal(buffer.length, MAX_DELTAS_PER_NODE);
    assert.equal(buffer[0]?.seq, 51);
    assert.equal(buffer.at(-1)?.seq, MAX_DELTAS_PER_NODE + 50);
  });

  test('what survives the bound is still reconciled against the transcript', () => {
    let buffer: readonly Delta[] = [];
    for (let seq = 1; seq <= MAX_DELTAS_PER_NODE + 10; seq += 1)
      buffer = appendDelta(buffer, text('r1', seq, `line ${seq}`));
    // The transcript has caught up with everything but the last two frames.
    const persisted = Array.from({ length: MAX_DELTAS_PER_NODE + 8 }, () => ({
      role: 'assistant' as const,
      runId: 'r1',
    }));
    assert.deepEqual(
      pendingDeltas([...buffer], persisted).map((d) => d.seq),
      [MAX_DELTAS_PER_NODE + 9, MAX_DELTAS_PER_NODE + 10],
    );
  });
});
