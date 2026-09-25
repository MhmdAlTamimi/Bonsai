import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { EventBus } from '../api/events.js';
import { HttpError } from '../api/http.js';
import { comparedExperiments } from '../api/references.js';
import { RunJobs } from './runNode.js';
import { ComparisonJobs } from './comparisons.js';
import { approachOf, comparisonFolder } from './comparisonSnapshot.js';
import { createChildNode, createProject } from '../projects.js';
import type {
  AgentRunner,
  Comparer,
  ComparisonSpec,
  RunEvent,
  RunSpec,
} from '../agent/AgentRunner.js';
import { compareOptions, COMPARE_TOOLS } from '../agent/ClaudeSdkRunner.js';
import { writeFile } from 'node:fs/promises';

/** Commits whatever "write <file>" names, so experiments have work to compare. */
class WritingRunner implements AgentRunner {
  async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    yield { type: 'session', sessionId: spec.resumeSessionId ?? `s-${spec.nodeId}` };
    const write = /^write (\S+)/.exec(spec.prompt);
    if (write !== null) await writeFile(join(spec.cwd, write[1]!), `${spec.prompt}\n`);
    yield { type: 'text', text: `did: ${spec.prompt}` };
    yield { type: 'done', inputTokens: 1, outputTokens: 1, costUsd: 0.01 };
  }
}

/** Records what it was asked and what its folder held, then answers. */
class ScriptedComparer implements Comparer {
  readonly specs: ComparisonSpec[] = [];
  readonly folders: string[][] = [];
  hold = false;
  private release: (() => void) | null = null;

  async *compare(spec: ComparisonSpec): AsyncIterable<RunEvent> {
    this.specs.push(spec);
    this.folders.push((await readdir(spec.cwd)).sort());
    yield { type: 'session', sessionId: spec.resumeSessionId ?? 'compare-session' };
    yield { type: 'model', model: 'test-model' };
    yield { type: 'tool', name: 'Read', detail: join(spec.cwd, 'README.md'), id: 't1' };
    if (this.hold && !spec.signal.aborted) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
        spec.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    if (spec.signal.aborted) return;
    yield { type: 'text', text: `answer to: ${spec.prompt.split('\n').at(-1)}` };
    yield { type: 'done', inputTokens: 1, outputTokens: 1, costUsd: 0.02 };
  }

  go(): void {
    this.hold = false;
    this.release?.();
  }
}

describe('comparisons', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;
  let jobs: RunJobs;
  let comparer: ScriptedComparer;
  let comparisons: ComparisonJobs;
  let projectId: string;
  let redis: string;
  let lru: string;

  const settle = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 300 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
  };
  const run = async (nodeId: string, prompt: string): Promise<void> => {
    jobs.start(nodeId, prompt);
    await settle(() => !jobs.isRunning(nodeId));
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-compare-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
    const settings = {
      model: () => null,
      effort: () => null,
      agentEnv: () => null,
      maxConcurrentRuns: () => 2,
    };
    jobs = new RunJobs(store, new EventBus(), new WritingRunner(), settings);
    comparer = new ScriptedComparer();
    comparisons = new ComparisonJobs(store, new EventBus(), comparer, settings, {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
    const created = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'acceptEdits',
    });
    projectId = created.projectId;
    const child = async (displayName: string): Promise<string> =>
      (
        await createChildNode(store, {
          projectId,
          parentId: created.masterNodeId,
          displayName,
          description: '',
        })
      ).nodeId;
    redis = await child('try-redis');
    lru = await child('try-lru');
    await run(redis, 'write cache.ts with redis');
    await run(lru, 'write lru.ts with an LRU map');
  });

  afterEach(async () => {
    comparer.go();
    await comparisons.drain();
    await jobs.drain();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const nodes = (...ids: string[]) => ids.map((id) => store.getNode(id)!);

  test('snapshots each experiment into a folder of its own, with an index', async () => {
    const row = await comparisons.create(projectId, nodes(redis, lru));
    const folder = comparisonFolder(store, projectId, row.id);
    assert.deepEqual((await readdir(folder)).sort(), ['README.md', 'try-lru', 'try-redis']);
    assert.deepEqual((await readdir(join(folder, 'try-redis'))).sort(), [
      'CONTEXT.md',
      'changes.diff',
      'conversation.md',
      'experiment.md',
      'files',
    ]);
    // Its whole repository at the compared commit, as plain files.
    assert.match(
      await readFile(join(folder, 'try-redis', 'files', 'cache.ts'), 'utf8'),
      /write cache\.ts/,
    );
    assert.match(await readFile(join(folder, 'README.md'), 'utf8'), /- try-redis\/ is try-redis/);

    const view = store.comparisonView(row);
    assert.equal(view.title, 'try-redis vs try-lru');
    assert.deepEqual(
      view.experiments.map((e) => [e.name, e.newRuns, e.facts.files]),
      [
        ['try-redis', 0, ['cache.ts']],
        ['try-lru', 0, ['lru.ts']],
      ],
    );
    assert.equal(view.experiments[0]!.facts.runs, 1);
    assert.ok(view.experiments[0]!.facts.added > 0);
  });

  test('answers read-only from the folder, and keep one conversation across questions', async () => {
    const row = await comparisons.create(projectId, nodes(redis, lru));
    comparisons.ask(row.id, 'which is simpler?');
    await settle(() => !comparisons.isRunning(row.id));
    comparisons.ask(row.id, 'and faster?');
    await settle(() => !comparisons.isRunning(row.id));

    assert.equal(comparer.specs[0]!.cwd, comparisonFolder(store, projectId, row.id));
    assert.equal(comparer.specs[0]!.resumeSessionId, null);
    assert.equal(comparer.specs[1]!.resumeSessionId, 'compare-session');
    const view = store.comparisonView(store.comparisons.get(row.id)!);
    assert.deepEqual(
      view.turns.map((t) => [t.status, t.model, t.costUsd]),
      [
        ['done', 'test-model', 0.02],
        ['done', 'test-model', 0.02],
      ],
    );
    assert.deepEqual(
      view.messages.map((m) => [m.role, m.kind]),
      [
        ['user', 'text'],
        ['assistant', 'tool_use'],
        ['assistant', 'text'],
        ['user', 'text'],
        ['assistant', 'tool_use'],
        ['assistant', 'text'],
      ],
    );
    assert.equal(view.messages[2]!.content, 'answer to: which is simpler?');
  });

  test('one question at a time, and a stopped answer is recorded as stopped', async () => {
    const row = await comparisons.create(projectId, nodes(redis, lru));
    comparer.hold = true;
    comparisons.ask(row.id, 'long one');
    await settle(() => comparer.specs.length === 1);
    assert.throws(() => comparisons.ask(row.id, 'another'), /still answering/);
    comparisons.stop(row.id);
    await settle(() => !comparisons.isRunning(row.id));
    assert.equal(store.comparisons.turns(row.id)[0]!.status, 'cancelled');
  });

  test('an experiment that moved on can be updated, and the agent is told', async () => {
    const row = await comparisons.create(projectId, nodes(redis, lru));
    await run(redis, 'write ttl.ts to expire keys');
    const stale = store.comparisonView(row).experiments;
    assert.deepEqual(
      stale.map((e) => e.newRuns),
      [1, 0],
    );

    const updated = await comparisons.refresh(row.id);
    assert.deepEqual(updated, ['try-redis (1 new run)']);
    const fresh = store.comparisonView(store.comparisons.get(row.id)!);
    assert.deepEqual(
      fresh.experiments.map((e) => e.newRuns),
      [0, 0],
    );
    assert.deepEqual(fresh.experiments[0]!.facts.files.sort(), ['cache.ts', 'ttl.ts']);
    assert.match(String(fresh.messages.at(-1)!.content), /Updated to their latest work: try-redis/);

    comparisons.ask(row.id, 'what changed?');
    await settle(() => !comparisons.isRunning(row.id));
    assert.match(
      comparer.specs.at(-1)!.prompt,
      /snapshots of try-redis \(1 new run\) were updated/,
    );
    // Said once, not with every question after.
    comparisons.ask(row.id, 'again?');
    await settle(() => !comparisons.isRunning(row.id));
    assert.equal(comparer.specs.at(-1)!.prompt, 'again?');
  });

  test('outlives a deleted experiment, which then cannot be updated', async () => {
    const row = await comparisons.create(projectId, nodes(redis, lru));
    store.deleteNode(lru);
    const view = store.comparisonView(row);
    assert.equal(view.experiments[1]!.nodeId, null);
    assert.equal(view.experiments[1]!.name, 'try-lru');
    assert.deepEqual(await comparisons.refresh(row.id), []);
  });

  test('deleting an included experiment is said in the comparison, which can still be asked', async () => {
    const row = await comparisons.create(projectId, nodes(redis, lru));
    assert.deepEqual(store.comparisons.including([lru]), [{ id: row.id, title: row.title }]);
    assert.deepEqual(store.comparisons.including([store.getNode(redis)!.parent_id!]), []);

    const announce = comparisons.beforeDeleting([lru]);
    store.deleteNode(lru);
    announce();
    assert.match(
      String(store.comparisons.messages(row.id).at(-1)!.content),
      /try-lru was deleted from the project\. This comparison keeps the copy it read/,
    );
    // Its copy is outside the experiment's folders, so the agent can still read it.
    assert.ok(
      (await readdir(comparisonFolder(store, projectId, row.id))).some((f) => f.includes('lru')),
    );
    comparisons.ask(row.id, 'what did try-lru do?');
    await settle(() => !comparisons.isRunning(row.id));
    assert.match(comparer.specs.at(-1)!.prompt, /try-lru was deleted from the project/);
    assert.match(comparer.specs.at(-1)!.prompt, /what did try-lru do\?$/);
  });

  test('deleting a comparison removes its folder and its conversation', async () => {
    const row = await comparisons.create(projectId, nodes(redis, lru));
    comparisons.ask(row.id, 'q');
    await settle(() => !comparisons.isRunning(row.id));
    await comparisons.delete(row.id);
    assert.equal(store.comparisons.get(row.id), undefined);
    await assert.rejects(readdir(comparisonFolder(store, projectId, row.id)));
  });

  test('two to four distinct experiments from the same project', () => {
    assert.equal(comparedExperiments(store, projectId, [redis, lru]).length, 2);
    assert.throws(() => comparedExperiments(store, projectId, [redis]), HttpError);
    assert.throws(() => comparedExperiments(store, projectId, [redis, redis]), HttpError);
    assert.throws(() => comparedExperiments(store, projectId, [redis, 'gone']), HttpError);
    assert.throws(() => comparedExperiments(store, projectId, 'x'), HttpError);
  });
});

describe('what a comparison may do', () => {
  test('its agent is offered reading tools and nothing else', async () => {
    const options = compareOptions(
      {
        comparisonId: 'c',
        cwd: '/data/compare/c',
        prompt: 'q',
        resumeSessionId: null,
        model: null,
        effort: null,
        agentEnv: null,
        signal: new AbortController().signal,
      },
      new AbortController(),
    );
    assert.deepEqual(options.tools, [...COMPARE_TOOLS]);
    assert.deepEqual([...COMPARE_TOOLS], ['Read', 'Glob', 'Grep']);
    assert.deepEqual(options.settingSources, []);
    const ask = options.canUseTool!;
    const context = { signal: new AbortController().signal, toolUseID: 't' } as Parameters<
      typeof ask
    >[2];
    assert.equal((await ask('Read', {}, context))?.behavior, 'allow');
    for (const tool of ['Bash', 'Write', 'Edit', 'WebFetch']) {
      assert.equal((await ask(tool, {}, context))?.behavior, 'deny', tool);
    }
  });

  test('an approach is the opening of the notes, without headings or testing', () => {
    assert.equal(
      approachOf(
        '# try-redis\n\n## Approach\n\nRedis in front of /search,\nwith a TTL.\n\n## Testing\n\nRan it.',
      ),
      'Redis in front of /search, with a TTL.',
    );
    assert.equal(approachOf('# x\n\n_The agent did not leave its own notes._\n'), null);
    assert.equal(approachOf(null), null);
  });
});
