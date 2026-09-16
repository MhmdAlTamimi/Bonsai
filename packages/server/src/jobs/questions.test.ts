import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentQuestion } from '@bonsai/shared';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { EventBus } from '../api/events.js';
import { LEFT_TO_AGENT, RunJobs } from './runNode.js';
import { adoptProject, createProject } from '../projects.js';
import { git } from '../git/exec.js';
import type { AgentRunner, ChoiceDecision, RunEvent, RunSpec } from '../agent/AgentRunner.js';

/**
 * D42: when the agent asks the user something, the run waits for the user.
 *
 * The bug this exists for: an agent in a project on `acceptEdits` called its
 * AskUserQuestion tool, the tool returned at once with no answer, and the agent
 * wrote "The user hasn't answered yet -- I'll wait" into a run that then ended
 * as `done`. Nothing was shown, and the question was not even recorded.
 *
 * So these are about the pipeline's half: the run parks in every mode, the
 * answer -- or "decide yourself" -- reaches the agent, stopping still frees it,
 * and the whole exchange is in the transcript.
 */
const QUESTION: AgentQuestion = {
  question: 'Which bucket should I read from?',
  header: 'Bucket',
  multiSelect: false,
  options: [
    { label: 'gs://docs-prod', description: 'Production documents' },
    { label: 'gs://docs-staging', description: 'Staging copy' },
  ],
};

class QuestionRunner implements AgentRunner {
  lastSpec: RunSpec | null = null;
  decisions: ChoiceDecision[] = [];
  asked!: Promise<void>;
  private announce!: () => void;

  constructor() {
    this.asked = new Promise<void>((resolve) => {
      this.announce = resolve;
    });
  }

  async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    this.lastSpec = spec;
    yield { type: 'session', sessionId: 'question-session' };
    if (spec.askChoices === null) {
      this.announce();
      yield { type: 'done', inputTokens: 0, outputTokens: 0, costUsd: 0 };
      return;
    }
    const pending = spec.askChoices({ questions: [QUESTION] });
    this.announce();
    const decision = await pending;
    this.decisions.push(decision);
    yield {
      type: 'text',
      text: decision.answered ? `reading ${decision.answers[QUESTION.question]}` : decision.reason,
    };
    yield { type: 'done', inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
}

describe('a question the agent asks', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;
  let jobs: RunJobs;
  let runner: QuestionRunner;
  let nodeId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-questions-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
    runner = new QuestionRunner();
    jobs = new RunJobs(store, new EventBus(), runner);
  });

  afterEach(async () => {
    await jobs.drain();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  async function created(
    permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
  ): Promise<void> {
    nodeId = (
      await createProject(store, { name: 'p', description: '', model: null, permissionMode })
    ).masterNodeId;
  }

  async function until(status: string): Promise<void> {
    for (let i = 0; i < 300 && store.getNode(nodeId)!.status !== status; i += 1)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(store.getNode(nodeId)!.status, status);
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 300 && jobs.activeCount() > 0; i += 1)
      await new Promise((r) => setTimeout(r, 10));
  }

  function transcript(): string {
    return store
      .listMessages(nodeId, 0)
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
  }

  for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const) {
    test(`is put to the user under "${mode}"`, async () => {
      await created(mode);
      jobs.start(nodeId, 'chunk the documents');
      await runner.asked;
      assert.notEqual(runner.lastSpec!.askChoices, null, 'every mode can ask');
      await until('needs_you');
    });
  }

  test('parks the run with the question, its options and its kind', async () => {
    await created('acceptEdits');
    jobs.start(nodeId, 'chunk the documents');
    await runner.asked;
    await until('needs_you');

    const view = store.treeView(store.getNode(nodeId)!.project_id).find((n) => n.id === nodeId)!;
    assert.equal(view.pendingQuestion?.kind, 'choice');
    assert.deepEqual(view.pendingQuestion?.questions, [QUESTION]);
    // The card shows the question in place of the description, as for permissions.
    assert.equal(view.summaryLine, QUESTION.question);
    assert.equal(store.listRuns(nodeId)[0]!.status, 'running', 'parked, not finished');
  });

  test('the answer reaches the agent, and the run carries on', async () => {
    await created('acceptEdits');
    jobs.start(nodeId, 'chunk the documents');
    await runner.asked;
    await until('needs_you');

    const question = store.pendingQuestion(nodeId)!;
    assert.equal(jobs.answerChoices(question.id, { [QUESTION.question]: 'gs://docs-prod' }), true);
    await settle();

    assert.deepEqual(runner.decisions, [
      { answered: true, answers: { [QUESTION.question]: 'gs://docs-prod' } },
    ]);
    assert.equal(store.getNode(nodeId)!.status, 'ready');
    assert.equal(store.listRuns(nodeId)[0]!.status, 'done');
    // What was asked, what it was choosing between, and what was chosen.
    assert.match(transcript(), /The agent asked: Which bucket should I read from\?/);
    assert.match(transcript(), /Options: gs:\/\/docs-prod · gs:\/\/docs-staging/);
    assert.match(transcript(), /Which bucket should I read from\? → gs:\/\/docs-prod/);
  });

  test('leaving it to the agent tells it to decide and say what it assumed', async () => {
    await created('acceptEdits');
    jobs.start(nodeId, 'chunk the documents');
    await runner.asked;
    await until('needs_you');

    assert.equal(jobs.leaveToAgent(store.pendingQuestion(nodeId)!.id), true);
    await settle();

    assert.deepEqual(runner.decisions, [{ answered: false, reason: LEFT_TO_AGENT }]);
    assert.equal(store.getNode(nodeId)!.status, 'ready');
    assert.match(transcript(), /Left the decision to the agent\./);
  });

  test('stopping a waiting run frees it, and the agent is told why', async () => {
    await created('acceptEdits');
    jobs.start(nodeId, 'chunk the documents');
    await runner.asked;
    await until('needs_you');

    assert.equal(jobs.cancel(nodeId), true);
    await settle();

    assert.equal(jobs.activeCount(), 0);
    assert.equal(jobs.pendingAsk(nodeId), null);
    assert.equal(store.getNode(nodeId)!.status, 'interrupted');
    assert.deepEqual(runner.decisions, [{ answered: false, reason: 'the run was stopped' }]);
    assert.match(transcript(), /Not answered: the run was stopped/);
  });

  test('only the matching kind of answer releases it, and only once', async () => {
    await created('acceptEdits');
    jobs.start(nodeId, 'chunk the documents');
    await runner.asked;
    await until('needs_you');
    const question = store.pendingQuestion(nodeId)!;

    // A permission answer is not an answer to a question the agent asked.
    assert.equal(jobs.answer(question.id, { allow: true }), false);
    assert.equal(store.getNode(nodeId)!.status, 'needs_you', 'still waiting');

    assert.equal(jobs.answerChoices(question.id, { [QUESTION.question]: 'gs://docs-prod' }), true);
    await settle();
    // Two windows open on the same experiment must not resume it twice.
    assert.equal(jobs.answerChoices(question.id, { [QUESTION.question]: 'again' }), false);
    assert.equal(jobs.leaveToAgent(question.id), false);
    assert.equal(runner.decisions.length, 1);
  });

  test('a read-only experiment can ask too', async () => {
    // An adopted project's master is read-only from the start: its folder is
    // the user's own checkout. Asking changes nothing, so it may still ask.
    const repo = join(root, 'mine');
    await mkdir(repo, { recursive: true });
    await git(['init', '--initial-branch=main', '.'], repo);
    await git(['config', 'user.email', 'you@example.com'], repo);
    await git(['config', 'user.name', 'You'], repo);
    await writeFile(join(repo, 'README.md'), '# mine\n', 'utf8');
    await git(['add', '-A'], repo);
    await git(['commit', '-m', 'first'], repo);
    nodeId = (
      await adoptProject(store, {
        path: repo,
        description: '',
        model: null,
        permissionMode: 'acceptEdits',
      })
    ).masterNodeId;

    jobs.start(nodeId, 'which bucket?');
    await runner.asked;
    assert.equal(runner.lastSpec!.readOnly, true);
    await until('needs_you');
    jobs.answerChoices(store.pendingQuestion(nodeId)!.id, {
      [QUESTION.question]: 'gs://docs-prod',
    });
    await settle();
    assert.equal(runner.decisions.length, 1);
  });

  test('permission questions written before questions existed still read as permissions', () => {
    const project = store.createProject({
      name: 'legacy',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const node = store.createNode({
      projectId: project.id,
      parentId: null,
      displayName: 'master',
      description: '',
      rootCommit: 'root',
    });
    store.createRun('legacy-run', node.id);
    // Exactly what older builds wrote: a bare request, or nothing at all.
    db.prepare(
      `INSERT INTO question (id, run_id, node_id, text, asked_at, request_json)
       VALUES ('q-bare', 'legacy-run', ?, 'May it?', '2026-01-01', NULL)`,
    ).run(node.id);
    assert.deepEqual(store.pendingQuestion(node.id), {
      id: 'q-bare',
      text: 'May it?',
      kind: 'permission',
    });
    assert.equal(store.getQuestion('q-bare')?.kind, 'permission');
  });
});
