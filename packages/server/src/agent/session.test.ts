import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BackgroundJob, RunActivity } from '@bonsai/shared';

import { ClaudeSdkRunner, type SessionQuery } from './ClaudeSdkRunner.js';
import { SessionActivity, detachedExited, type SessionHooks } from './session.js';
import type { RunEvent, RunSpec } from './AgentRunner.js';

/**
 * D43: a run ends when the work ends, not when the agent's turn does.
 *
 * The incident behind this: an agent started `uv sync` and a batch run in the
 * background and ended its turn to wait for them. Bonsai took the end of the
 * turn as the end of the run, committed and said Finished, and the harness
 * stopped the tracked job seconds later. The experiment kept writing files
 * into an experiment that claimed to be done.
 *
 * The harness side was verified against the real SDK (a held-open session
 * lets the job finish and wakes the agent). These tests pin Bonsai's side,
 * with a scripted session standing in for the harness.
 */

const ids = { uuid: '00000000-0000-4000-8000-000000000000', session_id: 'session-1' };

const say = (text: string, parent: string | null = null): SDKMessage =>
  ({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: parent,
    ...ids,
  }) as unknown as SDKMessage;

const callTool = (id: string, name: string, command: string): SDKMessage =>
  ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input: { command } }] },
    parent_tool_use_id: null,
    ...ids,
  }) as unknown as SDKMessage;

const toolReturned = (id: string): SDKMessage =>
  ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    parent_tool_use_id: null,
    ...ids,
  }) as unknown as SDKMessage;

const liveTasks = (
  ...tasks: Array<{ task_id: string; description: string; ambient?: boolean }>
): SDKMessage =>
  ({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: tasks.map((t) => ({ task_type: 'local_bash', ...t })),
    ...ids,
  }) as unknown as SDKMessage;

const turnOver = (costUsd: number, queued = 0): SDKMessage =>
  ({
    type: 'result',
    subtype: 'success',
    total_cost_usd: costUsd,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    queued_turn_count: queued,
    ...ids,
  }) as unknown as SDKMessage;

/** Stands in for the harness: messages come out when the test says, and input is recorded. */
class ScriptedSession implements SessionQuery {
  readonly received: string[] = [];
  readonly stopped: string[] = [];
  inputClosed = false;
  private readonly out: SDKMessage[] = [];
  private ended = false;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;

  constructor(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) {
    params.options.abortController?.signal.addEventListener('abort', () => {
      this.failure = new Error('aborted');
      this.notify();
    });
    void (async () => {
      for await (const message of params.prompt) {
        const content = message.message.content;
        this.received.push(typeof content === 'string' ? content : '');
      }
      // A closed input is how the session is told to end; the harness exits.
      this.inputClosed = true;
      this.ended = true;
      this.notify();
    })();
  }

  emit(...messages: SDKMessage[]): void {
    this.out.push(...messages);
    this.notify();
  }

  stopTask(taskId: string): Promise<void> {
    this.stopped.push(taskId);
    return Promise.resolve();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for (;;) {
      const next = this.out.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.failure !== null) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

function start(detached: BackgroundJob[] = []): {
  session: Promise<ScriptedSession>;
  stop: AbortController;
  finish: AbortController;
  activity: RunActivity[];
  events: RunEvent[];
  done: Promise<void>;
} {
  let ready!: (session: ScriptedSession) => void;
  const session = new Promise<ScriptedSession>((resolve) => (ready = resolve));
  const runner = new ClaudeSdkRunner((params) => {
    const scripted = new ScriptedSession(params);
    ready(scripted);
    return scripted;
  });
  const stop = new AbortController();
  const finish = new AbortController();
  const activity: RunActivity[] = [];
  const events: RunEvent[] = [];
  const spec: RunSpec = {
    runId: 'r',
    nodeId: 'n',
    cwd: '/tmp',
    prompt: 'train the model',
    resumeSessionId: null,
    forkSession: false,
    readOnly: false,
    successCriteria: null,
    verificationHint: null,
    model: null,
    effort: null,
    permissionMode: 'acceptEdits',
    agentEnv: null,
    ask: null,
    askChoices: null,
    signal: stop.signal,
    finishNow: finish.signal,
    onActivity: (a) => activity.push(a),
    backgroundLeftovers: () => Promise.resolve([...detached]),
  };
  const done = (async () => {
    for await (const event of runner.run(spec)) events.push(event);
  })();
  return { session, stop, finish, activity, events, done };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.ok(condition(), `timed out waiting for: ${what}`);
}

/** Lets every message already emitted be handled. */
const drained = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('a run and its background work', () => {
  test('a turn that leaves nothing running ends the run', async () => {
    const run = start();
    const session = await run.session;
    await until(() => session.received.length === 1, 'the prompt to arrive');
    assert.match(session.received[0]!, /^train the model\n\nBonsai run context:/);

    session.emit(say('Done.'), turnOver(0.01));
    await run.done;

    assert.equal(session.inputClosed, true);
    assert.deepEqual(
      run.events.map((e) => e.type),
      ['session', 'text', 'done'],
    );
  });

  test('a turn that leaves a job running waits, and the woken turn ends the run', async () => {
    const run = start();
    const session = await run.session;

    session.emit(
      callTool('t1', 'Bash', 'uv sync'),
      liveTasks({ task_id: 'b1', description: 'Install dependencies' }),
      toolReturned('t1'),
      say('Waiting for the install.'),
      turnOver(0.01),
    );
    await drained();
    assert.equal(session.inputClosed, false, 'the session stays open while the job runs');
    assert.equal(run.activity.at(-1)?.state, 'waiting');
    assert.deepEqual(
      run.activity.at(-1)?.background.map((job) => [job.description, job.tracked]),
      [['Install dependencies', true]],
    );

    // The job ends. The harness wakes the agent, which is working again.
    session.emit(liveTasks());
    await drained();
    assert.equal(run.activity.at(-1)?.state, 'working');
    assert.equal(session.inputClosed, false, 'the woken turn has not happened yet');

    session.emit(say('Installed; all tests pass.'), turnOver(0.03));
    await run.done;
    assert.equal(session.inputClosed, true);
    const totals = run.events.filter((e) => e.type === 'done');
    assert.equal(totals.length, 2);
    // Each result carries the running total, so the last one is the run's cost.
    assert.equal(totals.at(-1)?.type === 'done' && totals.at(-1)!.costUsd, 0.03);
  });

  test('the harness’s own watchers are not work to wait for', async () => {
    const run = start();
    const session = await run.session;
    session.emit(
      liveTasks({ task_id: 'w1', description: 'watch for changes', ambient: true }),
      turnOver(0.01),
    );
    await run.done;
    assert.equal(session.inputClosed, true);
  });

  test('Finish now stops the jobs and ends the run without an error', async () => {
    const run = start();
    const session = await run.session;
    session.emit(liveTasks({ task_id: 'b1', description: 'dev server' }), turnOver(0.01));
    await drained();
    assert.equal(run.activity.at(-1)?.state, 'waiting');

    run.finish.abort();
    await run.done;
    assert.deepEqual(session.stopped, ['b1']);
    assert.equal(session.inputClosed, true, 'closed, not killed: the run ends normally');
    assert.equal(
      run.events.some((e) => e.type === 'error'),
      false,
    );
  });

  test('Stop stops the jobs first, then ends the session', async () => {
    const run = start();
    const session = await run.session;
    session.emit(liveTasks({ task_id: 'b1', description: 'training' }), turnOver(0.01));
    await drained();

    run.stop.abort();
    await run.done; // an abort is not a failure, so this does not throw
    assert.deepEqual(session.stopped, ['b1']);
  });

  test('the tool in progress is reported, and cleared when it returns', async () => {
    const run = start();
    const session = await run.session;
    session.emit(callTool('t1', 'Bash', 'pytest -q'));
    await drained();
    assert.deepEqual(
      run.activity.at(-1)?.tool && [
        run.activity.at(-1)!.tool!.name,
        run.activity.at(-1)!.tool!.detail,
      ],
      ['Bash', 'pytest -q'],
    );

    session.emit(toolReturned('t1'));
    await drained();
    assert.equal(run.activity.at(-1)?.tool, null);

    session.emit(turnOver(0));
    await run.done;
  });

  test('a subagent speaking is not the agent waking up', async () => {
    const run = start();
    const session = await run.session;
    session.emit(liveTasks({ task_id: 'a1', description: 'research agent' }), turnOver(0.01));
    await drained();

    session.emit(say('subagent progress', 'toolu_parent'));
    await drained();
    assert.ok(
      run.events.some((e) => e.type === 'text' && e.text.includes('[Subagent · toolu_parent]')),
    );
    await drained();
    assert.equal(run.activity.at(-1)?.state, 'waiting');

    run.stop.abort();
    await run.done;
  });

  test('messages already queued mean another turn follows', async () => {
    const run = start();
    const session = await run.session;
    session.emit(turnOver(0.01, 1));
    await drained();
    assert.equal(session.inputClosed, false);

    session.emit(turnOver(0.02));
    await run.done;
    assert.equal(session.inputClosed, true);
  });
});

describe('waiting for the agent to be woken', () => {
  function tracker(overrides: Partial<SessionHooks> = {}): {
    activity: SessionActivity;
    reports: RunActivity[];
    said: string[];
    ended: () => number;
  } {
    const reports: RunActivity[] = [];
    const said: string[] = [];
    let ended = 0;
    const activity = new SessionActivity({
      report: (a) => reports.push(a),
      end: () => (ended += 1),
      say: (text) => said.push(text),
      leftovers: () => Promise.resolve([]),
      ...overrides,
    });
    return { activity, reports, said, ended: () => ended };
  }

  test('if the harness never wakes it, the run still ends', async () => {
    const t = tracker({ wakeGraceMs: 10 });
    t.activity.jobsChanged([{ task_id: 'b1', description: 'job' }]);
    assert.equal(await t.activity.turnEnded(0), false);
    t.activity.jobsChanged([]);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(t.ended(), 1);
  });

  test('a turn starting in time cancels that', async () => {
    const t = tracker({ wakeGraceMs: 30 });
    t.activity.jobsChanged([{ task_id: 'b1', description: 'job' }]);
    await t.activity.turnEnded(0);
    t.activity.jobsChanged([]);
    t.activity.thinking();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(t.ended(), 0);
    t.activity.dispose();
  });

  test('thinking is not a turn when no wake is expected', async () => {
    const t = tracker();
    t.activity.jobsChanged([{ task_id: 'a1', description: 'background subagent' }]);
    await t.activity.turnEnded(0);
    t.activity.thinking();
    assert.equal(t.reports.at(-1)?.state, 'waiting');
    t.activity.dispose();
  });
});

describe('work detached outside the harness', () => {
  test('a turn that leaves a detached process running waits for it', async () => {
    const run = start([
      { id: 'pid:1', description: 'nohup python run.py', tracked: false, startedAt: '' },
    ]);
    const session = await run.session;
    session.emit(say('Started it with nohup.'), turnOver(0.01));
    await drained();

    assert.equal(session.inputClosed, false);
    assert.equal(run.activity.at(-1)?.state, 'waiting');
    assert.equal(run.activity.at(-1)?.background[0]?.tracked, false);

    run.stop.abort();
    await run.done;
  });

  test('when it exits the agent is told, since the harness never knew about it', async () => {
    const TRAIN: BackgroundJob = {
      id: 'pid:4242',
      description: 'python train.py',
      tracked: false,
      startedAt: '2026-09-16T12:00:00.000Z',
    };
    let running = [TRAIN];
    const reports: RunActivity[] = [];
    const said: string[] = [];
    const activity = new SessionActivity({
      report: (a) => reports.push(a),
      end: () => undefined,
      say: (text) => said.push(text),
      leftovers: () => Promise.resolve(running),
      pollMs: 10,
    });

    assert.equal(await activity.turnEnded(0), false);
    assert.equal(reports.at(-1)?.state, 'waiting');

    running = [];
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(said, [detachedExited([TRAIN])]);
    assert.match(said[0]!, /`python train.py`/);
    assert.equal(reports.at(-1)?.state, 'working');
    assert.deepEqual(reports.at(-1)?.background, []);

    // The turn that follows ends the run, now that nothing is left.
    activity.turnStarted();
    assert.equal(await activity.turnEnded(0), true);
    activity.dispose();
  });

  test('a detached process keeps the start time it was first seen with', async () => {
    let scans = 0;
    const reports: RunActivity[] = [];
    const activity = new SessionActivity({
      report: (a) => reports.push(a),
      end: () => undefined,
      say: () => undefined,
      leftovers: () => {
        scans += 1;
        return Promise.resolve([
          { id: 'pid:7', description: 'job', tracked: false, startedAt: `scan ${scans}` },
        ]);
      },
    });
    await activity.turnEnded(0);
    activity.turnStarted();
    await activity.turnEnded(0);
    activity.dispose();

    assert.equal(scans, 2);
    assert.equal(reports.at(-1)?.background[0]?.startedAt, 'scan 1');
  });
});
