import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from './open.js';
import { Store } from './store.js';

test('reported usage survives interruption and deletion without double counting or separating final SQL state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bonsai-usage-'));
  let db = openDatabase(dir);
  try {
    let store = new Store(db, join(dir, 'repos'));
    const project = store.createProject({
      name: 'Usage',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const master = store.createNode({
      projectId: project.id,
      parentId: null,
      displayName: 'master',
      description: '',
      rootCommit: 'fixture-base',
    });
    const child = store.createNode({
      projectId: project.id,
      parentId: master.id,
      displayName: 'Delete me',
      description: '',
    });
    const metrics = {
      type: 'done' as const,
      costUsd: 0.006,
      inputTokens: 1000,
      outputTokens: 100,
      usageStatus: 'recorded' as const,
    };
    store.enqueueRun('run', child.id, {
      prompt: 'fixture',
      command: false,
      referenceIds: [],
      experimentIds: [],
    });
    store.runs.recordUsage('run', metrics, 'none');
    store.runs.recordUsage('run', metrics, 'none');
    assert.equal(store.usage.projectCost(project.id), 0.006);
    assert.equal(
      store.usage.view(project.id).experiments.find((row) => row.id === child.id)!.runs[0]!.status,
      'running',
    );
    // The ledger participates in the same database transaction as final status and commits.
    // Fail AFTER run/ledger updates, at the final node-status write.
    db.exec(
      "CREATE TRIGGER fail_finish BEFORE UPDATE OF status ON node BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
    );
    assert.throws(
      () =>
        store.completeRun(
          'run',
          child.id,
          { status: 'done', reason: 'finished', error: null },
          { cost: 0.012, inputTokens: 2000, outputTokens: 200 },
          { status: 'ready' },
        ),
      /fixture/,
    );
    assert.equal(store.usage.projectCost(project.id), 0.006);
    db.exec('DROP TRIGGER fail_finish');
    db.close();
    db = openDatabase(dir);
    store = new Store(db, join(dir, 'repos'));
    store.markOrphanedRunsInterrupted();
    assert.equal(
      store.usage.view(project.id).experiments.find((row) => row.id === child.id)!.runs[0]!.status,
      'failed',
    );
    assert.equal(store.usage.projectCost(project.id), 0.006);
    store.deleteNode(child.id);
    const deleted = store.usage.view(project.id).experiments.find((row) => row.id === child.id)!;
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.name, 'Delete me');
    assert.equal(deleted.runs[0]!.apiKeySource, 'none');
    assert.equal(store.usage.projectCost(project.id), 0.006);

    const comparison = store.comparisons.create(project.id, 'Compare fixture', []);
    const turn = store.comparisons.startTurn(comparison.id);
    store.comparisons.recordUsage(turn, metrics, 'none');
    store.comparisons.finishTurn(turn, {
      status: 'failed',
      costUsd: 0.006,
      model: 'fixture',
      error: 'fixture failed after paid turn',
    });
    store.comparisons.delete(comparison.id);
    assert.equal(store.usage.view(project.id).comparisons[0]!.deleted, true);
    store.usage.createDraft('draft', project.id, 'Reference draft');
    store.usage.recordDraft('draft', { type: 'model', model: 'fixture', apiKeySource: 'none' });
    store.usage.recordDraft('draft', metrics);
    store.usage.recordDraft('draft', metrics);
    store.usage.finishDraft('draft', 'failed');
    store.usage.createDraft('unreported', project.id, 'Interrupted draft');
    store.usage.markOrphanedDrafts();
    const usage = store.usage.view(project.id);
    assert.equal(usage.drafts[0]!.apiKeySource, 'none');
    assert.equal(usage.drafts[1]!.usageStatus, 'unknown');
    assert.equal(usage.drafts[1]!.status, 'failed');
    assert.ok(Math.abs(store.usage.projectCost(project.id) - 0.018) < 1e-9);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    store.deleteProject(project.id);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM usage_entry').get()!['n']), 0);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a schema-27 upgrade preserves unverified legacy estimates without counting them as corrected totals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bonsai-usage-upgrade-'));
  let db = openDatabase(dir);
  try {
    let store = new Store(db, join(dir, 'repos'));
    const project = store.createProject({
      name: 'Legacy',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const node = store.createNode({
      projectId: project.id,
      parentId: null,
      displayName: 'master',
      description: '',
    });
    store.createRun('old', node.id);
    store.finishRun(
      'old',
      { status: 'done', reason: 'finished', error: null },
      { cost: 0.25, inputTokens: 1000, outputTokens: 100 },
    );
    // The migration must also label totals waiting in an older Git-save journal.
    db.prepare('INSERT INTO run_save(run_id, payload_json) VALUES(?, ?)').run(
      'old',
      JSON.stringify({ totals: { cost: 0.25, inputTokens: 1000, outputTokens: 100 } }),
    );
    for (const table of ['run', 'comparison_turn'])
      for (const action of ['insert', 'update']) db.exec(`DROP TRIGGER ${table}_usage_${action}`);
    db.exec(
      "ALTER TABLE run DROP COLUMN usage_status; ALTER TABLE comparison_turn DROP COLUMN usage_json; DROP TABLE usage_entry; UPDATE meta SET value = '27' WHERE key = 'schema_version';",
    );
    db.close();
    db = openDatabase(dir);
    store = new Store(db, join(dir, 'repos'));
    const old = store.usage.view(project.id).experiments[0]!.runs[0]!;
    assert.equal(old.costUsd, 0.25);
    assert.equal(old.usageStatus, 'legacy');
    const pendingTotals = (
      JSON.parse(
        String(
          db.prepare('SELECT payload_json FROM run_save WHERE run_id = ?').get('old')![
            'payload_json'
          ],
        ),
      ) as { totals: { usageStatus: string } }
    ).totals;
    assert.equal(pendingTotals.usageStatus, 'legacy');
    assert.equal(store.usage.projectCost(project.id), 0);
    store.createRun('new', node.id);
    store.runs.recordUsage(
      'new',
      { type: 'done', costUsd: 0.006, inputTokens: 1000, outputTokens: 100 },
      'none',
    );
    assert.equal(store.usage.projectCost(project.id), 0.006);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
