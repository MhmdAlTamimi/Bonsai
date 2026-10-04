import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/open.js';
import { Store } from '../db/store.js';
import { createProject, createChildNode } from '../projects.js';
import { EventBus } from '../api/events.js';
import { FakeRunner } from '../agent/FakeRunner.js';
import type { RunEvent, RunSpec } from '../agent/AgentRunner.js';
import { RunJobs } from './runNode.js';
import { silentLogger } from '../log.js';

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
