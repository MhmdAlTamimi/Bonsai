import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CompactionNote } from '@bonsai/shared';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { EventBus } from '../api/events.js';
import { RunJobs } from './runNode.js';
import { createProject } from '../projects.js';
import type { AgentRunner, RunEvent, RunSpec } from '../agent/AgentRunner.js';
import { OperationConflict } from '../domain/errors.js';

/**
 * Compacting a conversation from the pipeline's side: what is sent, what is
 * kept, and what it does to where a child's copy of the conversation is cut.
 */
class CompactingRunner implements AgentRunner {
  readonly specs: RunSpec[] = [];
  notice: string | null = null;

  async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    this.specs.push({ ...spec });
    yield { type: 'session', sessionId: spec.resumeSessionId ?? 'session-1' };
    if (spec.isCommand === true) {
      if (this.notice !== null) yield { type: 'notice', text: this.notice };
      else yield { type: 'compacted', trigger: 'manual', tokensBefore: 9000, tokensAfter: 1200 };
    } else {
      yield { type: 'text', text: 'answered' };
      yield { type: 'position', messageId: `end-of-run-${this.specs.length}` };
    }
    await Promise.resolve();
    yield { type: 'done', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  }
}

describe('compacting a conversation', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;
  let jobs: RunJobs;
  let runner: CompactingRunner;
  let masterId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-compact-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
    runner = new CompactingRunner();
    jobs = new RunJobs(store, new EventBus(), runner);
    masterId = (
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

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 200 && jobs.isRunning(masterId); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  test('there is nothing to compact before the first conversation', () => {
    assert.throws(() => jobs.compact(masterId, null), OperationConflict);
  });

  test('sends /compact as a command, read-only, and commits nothing', async () => {
    jobs.start(masterId, '? explain');
    await settle();
    const head = store.getNode(masterId)!.head_commit;

    jobs.compact(masterId, 'keep the test results');
    await settle();

    const spec = runner.specs.at(-1)!;
    assert.equal(spec.prompt, '/compact keep the test results');
    assert.equal(spec.isCommand, true);
    assert.equal(spec.readOnly, true);
    assert.equal(spec.resumeSessionId, 'session-1');
    assert.equal(store.getNode(masterId)!.head_commit, head);
    assert.equal(store.listRuns(masterId).at(-1)!.status, 'done');
  });

  test('keeps a record in the transcript: what was asked and what it did', async () => {
    jobs.start(masterId, '? explain');
    await settle();
    jobs.compact(masterId, null);
    await settle();

    const messages = store.listMessages(masterId, 0);
    const asked = messages.filter((m) => m.role === 'user').at(-1)!;
    assert.equal(asked.content, '/compact');
    const note = messages.at(-1)!;
    assert.equal(note.role, 'system');
    const expected: CompactionNote = {
      compaction: { trigger: 'manual', tokensBefore: 9000, tokensAfter: 1200 },
    };
    assert.deepEqual(note.content, expected);
  });

  test("a compaction resets where a child's copy is cut, until the next finished run", async () => {
    jobs.start(masterId, '? first');
    await settle();
    assert.equal(store.getNode(masterId)!.session_position, 'end-of-run-1');

    // The old cut point would copy the turns the summary just replaced.
    jobs.compact(masterId, null);
    await settle();
    assert.equal(store.getNode(masterId)!.session_position, null);

    jobs.start(masterId, '? after');
    await settle();
    assert.equal(store.getNode(masterId)!.session_position, 'end-of-run-3');
  });

  test('a compaction that did nothing leaves its reason in the transcript', async () => {
    jobs.start(masterId, '? first');
    await settle();
    runner.notice = 'Not enough messages to compact.';
    jobs.compact(masterId, null);
    await settle();
    const note = store.listMessages(masterId, 0).at(-1)!;
    assert.equal(note.role, 'system');
    assert.equal(note.content, 'Not enough messages to compact.');
    // Nothing was compacted, so the cut point stays where the last run left it.
    assert.equal(store.getNode(masterId)!.session_position, 'end-of-run-1');
  });
});
