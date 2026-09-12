import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from './db/open.js';
import { Store } from './db/store.js';
import { EventBus } from './api/events.js';
import { RunJobs } from './jobs/runNode.js';
import { createProject } from './projects.js';
import { FileLogger } from './log.js';
import type { AgentRunner, RunEvent, RunSpec } from './agent/AgentRunner.js';

/**
 * The log.
 *
 * Two things are asserted, and the second matters more than the first. One:
 * that a completed, a cancelled and a failed run each leave a line you could
 * actually read. Two: that no line ever contains the prompt, the agent's
 * output, or a credential -- because the log is the artefact most likely to be
 * pasted into a bug report, and the things it must not contain are the user's
 * private code and their key.
 */

const SECRET_PROMPT = 'refactor the billing code, my key is sk-ant-notarealkey-1234567890';

class ScriptedRunner implements AgentRunner {
  constructor(private readonly mode: 'writes' | 'fails' | 'hangs') {}

  async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    yield { type: 'session', sessionId: 'sess-1' };
    yield {
      type: 'model',
      model: 'claude-test',
      apiKeySource: 'none',
      tools: ['Read', 'Write', 'Bash'],
    };
    yield { type: 'text', text: 'a sentence the log must never contain: hunter2' };
    yield { type: 'tool', name: 'Write', detail: 'secret-file.ts' };

    if (this.mode === 'fails') {
      yield { type: 'error', error: 'the model refused' };
      return;
    }
    if (this.mode === 'hangs') {
      await new Promise<void>((resolve) => {
        if (spec.signal.aborted) return resolve();
        spec.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return;
    }

    await writeFile(join(spec.cwd, 'out.txt'), 'x', 'utf8');
    yield { type: 'done', inputTokens: 100, outputTokens: 20, costUsd: 0.02 };
  }
}

describe('the log file', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;
  let logger: FileLogger;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-log-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
    logger = new FileLogger(root);
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  async function runOnce(
    mode: 'writes' | 'fails' | 'hangs',
  ): Promise<Array<Record<string, unknown>>> {
    const jobs = new RunJobs(store, new EventBus(), new ScriptedRunner(mode), undefined, logger);
    const created = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    jobs.start(created.masterNodeId, SECRET_PROMPT);
    if (mode === 'hangs') {
      // Give it a moment to be genuinely in flight before stopping it.
      await new Promise((r) => setTimeout(r, 30));
      jobs.cancel(created.masterNodeId);
    }
    for (let i = 0; i < 300 && jobs.activeCount() > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return logger.tail(50).map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  test('a completed run leaves a line with everything needed to explain it', async () => {
    const lines = await runOnce('writes');
    const done = lines.find((l) => l['event'] === 'run.done');
    assert.ok(done, 'no run.done line');

    // The questions actually asked when a run looks wrong.
    assert.equal(done['model'], 'claude-test');
    assert.equal(done['apiKeySource'], 'none');
    assert.equal(done['readOnly'], false);
    assert.equal(done['toolCalls'], 1);
    assert.equal(done['toolsOffered'], 3);
    assert.equal(done['committed'], true);
    assert.equal(done['inputTokens'], 100);
    assert.equal(done['costUsd'], 0.02);
    assert.equal(typeof done['durationMs'], 'number');
    assert.equal(typeof done['t'], 'string');
  });

  test('a failed run says what failed', async () => {
    const lines = await runOnce('fails');
    const failed = lines.find((l) => l['event'] === 'run.failed');
    assert.ok(failed, 'no run.failed line');
    assert.equal(failed['level'], 'error');
    assert.equal(failed['error'], 'the model refused');
    assert.equal(failed['toolCalls'], 1);
  });

  test('a cancelled run is recorded as cancelled, not as a failure', async () => {
    const lines = await runOnce('hangs');
    assert.ok(
      lines.find((l) => l['event'] === 'run.cancelled'),
      'no run.cancelled line',
    );
    assert.equal(
      lines.find((l) => l['event'] === 'run.failed'),
      undefined,
    );
  });

  test('never writes the prompt, the output, or anything key-shaped', async () => {
    for (const mode of ['writes', 'fails', 'hangs'] as const) {
      await runOnce(mode);
    }
    const dir = join(root, 'logs');
    let all = '';
    for (const name of await readdir(dir)) all += await readFile(join(dir, name), 'utf8');

    assert.ok(!all.includes('sk-ant-'), 'a key-shaped string reached the log');
    assert.ok(!all.includes('refactor the billing code'), 'the prompt reached the log');
    assert.ok(!all.includes('hunter2'), "the agent's output reached the log");
    assert.ok(!all.includes('secret-file.ts'), 'a file path from the run reached the log');
    // But the SHAPE of the prompt is recorded, which is what makes "the prompt
    // was enormous" answerable without keeping a word of it.
    assert.ok(all.includes(`"promptChars":${SECRET_PROMPT.length}`));
  });

  test('the run row keeps the tools, the call count and the duration', async () => {
    const jobs = new RunJobs(
      store,
      new EventBus(),
      new ScriptedRunner('writes'),
      undefined,
      logger,
    );
    const created = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    jobs.start(created.masterNodeId, SECRET_PROMPT);
    for (let i = 0; i < 300 && jobs.activeCount() > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const run = store.listRuns(created.masterNodeId)[0]!;
    // The list the runner has always yielded and the pipeline used to drop.
    assert.deepEqual(run.toolsOffered, ['Read', 'Write', 'Bash']);
    assert.equal(run.toolCalls, 1);
    assert.ok((run.durationMs ?? 0) >= 0);
  });

  test('rotates by day and keeps a fortnight', async () => {
    const dir = join(root, 'logs');
    await mkdir(dir, { recursive: true });
    // Twenty days of history, oldest first.
    for (let d = 1; d <= 20; d += 1) {
      await writeFile(join(dir, `bonsai-2026-01-${String(d).padStart(2, '0')}.log`), '{}\n');
    }
    // Constructing a logger prunes; so does the first write on a new day.
    new FileLogger(root).info('app.start');

    const left = (await readdir(dir)).filter((n) => n.startsWith('bonsai-')).sort();
    // Fourteen kept from the old set, plus today's file.
    assert.equal(left.length, 15);
    assert.equal(left[0], 'bonsai-2026-01-07.log');
  });
});
