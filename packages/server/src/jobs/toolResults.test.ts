import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ServerEvent, ToolResultContent } from '@bonsai/shared';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { EventBus } from '../api/events.js';
import { RunJobs } from './runNode.js';
import { createProject } from '../projects.js';
import type { AgentRunner, RunEvent, RunSpec } from '../agent/AgentRunner.js';

/** A run that calls one command and one edit, and reports what each produced. */
const RAN: ToolResultContent = {
  toolUseId: 'call-1',
  name: 'Bash',
  ok: true,
  output: ['reading 183 documents', '183 files · 17,604 lines'],
};
const EDITED: ToolResultContent = {
  toolUseId: 'call-2',
  name: 'Edit',
  ok: true,
  edit: {
    path: 'chunk_writer.py',
    added: 1,
    removed: 0,
    lines: [{ kind: 'add', text: 'header = sheet_header(rows)', newLine: 58 }],
  },
};

class ToolRunner implements AgentRunner {
  async *run(_spec: RunSpec): AsyncIterable<RunEvent> {
    await Promise.resolve();
    yield { type: 'session', sessionId: 'tools' };
    yield { type: 'tool', name: 'Bash', detail: 'python chunk_writer.py', id: 'call-1' };
    yield { type: 'tool_result', result: RAN };
    yield { type: 'tool', name: 'Edit', detail: 'chunk_writer.py', id: 'call-2' };
    yield { type: 'tool_result', result: EDITED };
    yield { type: 'done', inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
}

class RecordingBus extends EventBus {
  readonly events: ServerEvent[] = [];
  override publish(projectId: string, event: ServerEvent): void {
    this.events.push(event);
    super.publish(projectId, event);
  }
}

describe('what a tool produced, in the transcript', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;
  let bus: RecordingBus;
  let jobs: RunJobs;
  let nodeId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-tool-results-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
    bus = new RecordingBus();
    jobs = new RunJobs(store, bus, new ToolRunner());
    nodeId = (
      await createProject(store, {
        name: 'p',
        description: '',
        model: null,
        permissionMode: 'acceptEdits',
      })
    ).masterNodeId;
  });
  afterEach(async () => {
    await jobs.drain();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  test('each call and its result are stored, paired by the call’s id', async () => {
    jobs.start(nodeId, 'chunk the documents');
    for (let i = 0; i < 300 && jobs.activeCount() > 0; i += 1)
      await new Promise((r) => setTimeout(r, 10));

    const messages = store.listMessages(nodeId, 0);
    const calls = messages.filter((m) => m.kind === 'tool_use');
    const results = messages.filter((m) => m.kind === 'tool_result');
    assert.deepEqual(
      calls.map((m) => (m.content as { id?: string }).id),
      ['call-1', 'call-2'],
    );
    assert.deepEqual(
      results.map((m) => m.content),
      [RAN, EDITED],
    );
    // The result follows its own call, so the conversation reads in order.
    assert.ok(messages.indexOf(calls[0]!) < messages.indexOf(results[0]!));
    assert.ok(messages.indexOf(results[0]!) < messages.indexOf(calls[1]!));
  });

  test('results reach an open conversation live, without refetching it', async () => {
    jobs.start(nodeId, 'chunk the documents');
    for (let i = 0; i < 300 && jobs.activeCount() > 0; i += 1)
      await new Promise((r) => setTimeout(r, 10));

    const streamed = bus.events.flatMap((e) =>
      e.type === 'run.delta' && e.toolResult !== undefined ? [e.toolResult] : [],
    );
    assert.deepEqual(streamed, [RAN, EDITED]);
  });
});
