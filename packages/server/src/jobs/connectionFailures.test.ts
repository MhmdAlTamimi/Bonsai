import { createLegacyProject as createProject } from '../testing/legacyProject.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/open.js';
import { Store } from '../db/store.js';
import { createChildNode } from '../projects.js';
import { EventBus } from '../api/events.js';
import { FakeRunner } from '../agent/FakeRunner.js';
import type { RunEvent, RunSpec } from '../agent/AgentRunner.js';
import { RunJobs } from './runNode.js';
import { silentLogger } from '../log.js';
import { ClaudeSdkRunner } from '../agent/ClaudeSdkRunner.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

class FailureRunner extends FakeRunner {
  override async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    await Promise.resolve();
    yield { type: 'error', error: '401 unauthorized fixture', apiFailure: spec.prompt === 'api' };
  }
}
test('only identified agent API failures change the Claude connection gate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bonsai-api-failure-source-'));
  const db = openDatabase(dir);
  try {
    const store = new Store(db, join(dir, 'repos'));
    const project = await createProject(store, {
      name: 'source of errors',
      description: '',
      model: null,
      permissionMode: 'acceptEdits',
    });
    const failures: string[] = [];
    const jobs = new RunJobs(store, new EventBus(), new FailureRunner(), undefined, silentLogger, {
      recordFailure: (message) => failures.push(message),
    });
    for (const prompt of ['setup', 'api']) {
      const child = await createChildNode(store, {
        projectId: project.projectId,
        parentId: project.masterNodeId,
        displayName: prompt,
        description: '',
      });
      jobs.start(child.nodeId, prompt);
      const deadline = Date.now() + 5000;
      while (jobs.isRunning(child.nodeId) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(jobs.isRunning(child.nodeId), false);
      assert.equal(store.listRuns(child.nodeId).at(-1)?.status, 'failed');
      assert.equal(failures.length, prompt === 'api' ? 1 : 0);
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('SDK EOF preserves partial files and fails the actual job without a successful commit or a connection-gate error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bonsai-incomplete-sdk-'));
  const db = openDatabase(dir);
  try {
    const store = new Store(db, join(dir, 'repos'));
    const project = await createProject(store, {
      name: 'EOF',
      description: '',
      model: null,
      permissionMode: 'acceptEdits',
    });
    const child = await createChildNode(store, {
      projectId: project.projectId,
      parentId: project.masterNodeId,
      displayName: 'Partial',
      description: '',
    });
    const runner = new ClaudeSdkRunner(({ options }) => ({
      stopTask: () => Promise.resolve(),
      async *[Symbol.asyncIterator]() {
        await writeFile(join(options.cwd!, 'unfinished.txt'), 'preserve this partial work');
        yield {
          type: 'assistant',
          parent_tool_use_id: null,
          session_id: 'fixture',
          uuid: 'fixture',
          message: { id: 'fixture', content: [{ type: 'text', text: 'Unfinished.' }] },
        } as unknown as SDKMessage;
        // Unexpected clean EOF, without an SDK result.
      },
    }));
    const failures: string[] = [];
    const jobs = new RunJobs(store, new EventBus(), runner, undefined, silentLogger, {
      recordFailure: (error) => failures.push(error),
    });
    jobs.start(child.nodeId, 'write a file');
    const deadline = Date.now() + 5000;
    while (jobs.isRunning(child.nodeId) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(jobs.isRunning(child.nodeId), false);
    const run = store.listRuns(child.nodeId).at(-1)!;
    assert.equal(run.status, 'failed');
    assert.match(run.error!, /ended before completing/);
    assert.equal(run.commitSha, null);
    assert.equal(run.usageStatus, 'unknown');
    assert.equal(store.getNode(child.nodeId)!.head_commit, null);
    assert.equal(
      await readFile(join(store.getNode(child.nodeId)!.worktree_path, 'unfinished.txt'), 'utf8'),
      'preserve this partial work',
    );
    assert.deepEqual(failures, []);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
