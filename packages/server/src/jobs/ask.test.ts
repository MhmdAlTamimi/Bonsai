import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { EventBus } from '../api/events.js';
import { RunJobs } from './runNode.js';
import { createProject } from '../projects.js';
import type { AgentRunner, PermissionDecision, RunEvent, RunSpec } from '../agent/AgentRunner.js';

/**
 * D34: the agent stops mid-run and waits for the user.
 *
 * `needs_you` has been in the schema, the state machine and the card since M1
 * with nothing able to reach it. What reaches it is the permission callback:
 * under the `default` permission mode a tool call is held until someone says
 * yes or no. So these tests are about the HOLD, not about the SDK -- whether
 * the node parks, whether the answer gets back to the agent, and whether the
 * run can still be got out of once it is parked.
 *
 * The last of those is the one worth writing tests for. A parked run is a
 * promise nobody has resolved: get the unwinding wrong and stopping the node
 * leaves an orphaned agent holding a concurrency slot for ever.
 */
class AskingRunner implements AgentRunner {
  /** The spec of the most recent run, so a test can see what it was offered. */
  lastSpec: RunSpec | null = null;
  /** What the user's answer turned into, as the agent received it. */
  decisions: PermissionDecision[] = [];
  /** Resolves once the run has actually asked, so tests need no sleep. */
  asked!: Promise<void>;
  private announceAsked!: () => void;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.asked = new Promise<void>((resolve) => {
      this.announceAsked = resolve;
    });
  }

  async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    this.lastSpec = spec;
    yield { type: 'session', sessionId: 'ask-session' };

    if (spec.ask === null) {
      // Nothing to ask with. Announced anyway so a test waiting on it is not
      // left hanging on the assertion it is trying to make.
      this.announceAsked();
      yield { type: 'done', inputTokens: 0, outputTokens: 0, costUsd: 0 };
      return;
    }

    const pending = spec.ask({ toolName: 'Bash', detail: 'rm -rf build' });
    this.announceAsked();
    const decision = await pending;
    this.decisions.push(decision);

    yield { type: 'text', text: decision.allow ? 'went ahead' : `told no: ${decision.reason}` };
    yield { type: 'done', inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
}

describe('a run that asks the user', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;
  let jobs: RunJobs;
  let runner: AskingRunner;
  let masterId: string;

  async function openWith(permissionMode: 'default' | 'acceptEdits'): Promise<void> {
    const created = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode,
    });
    masterId = created.masterNodeId;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-ask-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
    runner = new AskingRunner();
    jobs = new RunJobs(store, new EventBus(), runner);
  });

  afterEach(async () => {
    await jobs.drain();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  /** Waits for the pipeline to unwind, which outlives the abort signal. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 300 && jobs.activeCount() > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Waits for the node's status to reach `want`, or gives up loudly. */
  async function until(want: string): Promise<void> {
    for (let i = 0; i < 300 && store.getNode(masterId)!.status !== want; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(store.getNode(masterId)!.status, want);
  }

  test('parks the node in needs_you with the question attached', async () => {
    await openWith('default');
    jobs.start(masterId, 'clean up the build');
    await runner.asked;
    await until('needs_you');

    // The card reads its question off the tree, so the question has to be
    // there the moment the status says there is one -- not a tick later.
    const view = store
      .treeView(store.getNode(masterId)!.project_id)
      .find((n) => n.id === masterId)!;
    assert.notEqual(view.pendingQuestion, null);
    assert.match(view.pendingQuestion!.text, /Bash/);
    assert.match(view.pendingQuestion!.text, /rm -rf build/);
    // The card shows the question in place of the description (PRD §7).
    assert.equal(view.summaryLine, view.pendingQuestion!.text);

    // Still one run, still open. Parking is not finishing.
    assert.equal(store.listRuns(masterId)[0]!.status, 'running');
  });

  test('allowing lets the run finish', async () => {
    await openWith('default');
    jobs.start(masterId, 'clean up the build');
    await runner.asked;
    await until('needs_you');

    const question = store.pendingQuestion(masterId)!;
    assert.equal(jobs.answer(question.id, { allow: true }), true);
    await settle();

    assert.deepEqual(runner.decisions, [{ allow: true }]);
    assert.equal(store.getNode(masterId)!.status, 'ready');
    assert.equal(store.listRuns(masterId)[0]!.status, 'done');
  });

  /**
   * The reason for the whole free-text field. A denial's message is handed to
   * the agent as the tool's result, so refusing is how you redirect a run
   * rather than merely end it.
   */
  test('a refusal carries the user"s words to the agent', async () => {
    await openWith('default');
    jobs.start(masterId, 'clean up the build');
    await runner.asked;
    await until('needs_you');

    const question = store.pendingQuestion(masterId)!;
    jobs.answer(question.id, { allow: false, reason: 'use `make clean` instead' });
    await settle();

    assert.deepEqual(runner.decisions, [{ allow: false, reason: 'use `make clean` instead' }]);
    // Refused, not failed: the agent was told no and carried on.
    assert.equal(store.getNode(masterId)!.status, 'ready');
  });

  test('the answer and the question both land in the transcript', async () => {
    await openWith('default');
    jobs.start(masterId, 'clean up the build');
    await runner.asked;
    await until('needs_you');

    jobs.answer(store.pendingQuestion(masterId)!.id, { allow: true });
    await settle();

    // "Why did this run stall for ten minutes" has to be answerable a week
    // later from the conversation alone.
    const text = store
      .listMessages(masterId, 0)
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    assert.match(text, /wants to use Bash/);
    assert.match(text, /Allowed\./);
  });

  test('the question stops being pending once answered', async () => {
    await openWith('default');
    jobs.start(masterId, 'clean up the build');
    await runner.asked;
    await until('needs_you');

    const question = store.pendingQuestion(masterId)!;
    jobs.answer(question.id, { allow: true });
    await settle();

    assert.equal(store.pendingQuestion(masterId), null);
    // Two windows open on the same node must not resume a run twice.
    assert.equal(jobs.answer(question.id, { allow: true }), false);
  });

  /**
   * The one that would otherwise leak.
   *
   * A parked run is waiting on a promise. If stopping the node does not
   * resolve it, the agent never returns, the pipeline never finishes, and the
   * concurrency slot is gone until the app restarts.
   */
  test('stopping a parked node frees it instead of hanging', async () => {
    await openWith('default');
    jobs.start(masterId, 'clean up the build');
    await runner.asked;
    await until('needs_you');
    assert.equal(jobs.activeCount(), 1);

    assert.equal(jobs.cancel(masterId), true);
    await settle();

    assert.equal(jobs.activeCount(), 0);
    assert.equal(store.getNode(masterId)!.status, 'interrupted');
    assert.equal(store.listRuns(masterId)[0]!.status, 'cancelled');
    // The agent was told, rather than left waiting.
    assert.equal(runner.decisions.length, 1);
    assert.equal(runner.decisions[0]!.allow, false);
    // And nothing is left pretending to be waiting for an answer.
    assert.equal(jobs.pendingAsk(masterId), null);
  });

  /**
   * `acceptEdits` means "do not ask me". A gate that ignored that would be a
   * worse bug than no gate: every run would stop on its first tool call, in
   * the mode the user chose precisely so that it would not.
   */
  test('no gate at all unless the mode is default', async () => {
    await openWith('acceptEdits');
    jobs.start(masterId, 'clean up the build');
    await settle();

    assert.equal(runner.lastSpec!.ask, null);
    assert.equal(runner.decisions.length, 0);
    assert.equal(store.getNode(masterId)!.status, 'ready');
  });
});
