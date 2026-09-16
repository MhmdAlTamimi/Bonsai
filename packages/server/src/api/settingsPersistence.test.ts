import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Settings } from '../settings.js';
import { Store } from '../db/store.js';
import { openInMemory } from '../db/open.js';

test('a failed settings write preserves both saved values and effective in-memory values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bonsai-settings-'));
  try {
    const settings = new Settings({
      port: 0,
      dataDir: dir,
      reposRoot: join(dir, 'repos'),
      defaultModel: null,
      defaultPermissionMode: 'default',
    });
    settings.update({ model: 'before' });
    const before = readFileSync(join(dir, 'settings.json'), 'utf8');
    mkdirSync(join(dir, 'settings.json.tmp'));
    assert.throws(() => settings.update({ model: 'after', effort: 'high' }));
    assert.equal(settings.model(), 'before');
    assert.equal(settings.effort(), null);
    assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project settings roll back together and new projects do not request .env automatically', () => {
  const db = openInMemory();
  try {
    const store = new Store(db, '/tmp/bonsai-settings');
    const project = store.createProject({
      name: 'settings',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    assert.equal(project.copy_files, '[]');
    db.exec(
      "CREATE TRIGGER reject_setup BEFORE UPDATE OF setup_command ON project BEGIN SELECT RAISE(ABORT, 'disk fixture'); END",
    );
    assert.throws(() =>
      store.saveProjectConfiguration(project.id, {
        model: 'after',
        copyFiles: ['.env'],
        setupCommand: 'false',
      }),
    );
    assert.equal(store.getProject(project.id)?.default_model, null);
    assert.equal(store.getProject(project.id)?.copy_files, '[]');
  } finally {
    db.close();
  }
});

test('changing future storage pins old created/adopted projects and their later experiments', () => {
  const db = openInMemory();
  try {
    let future = '/tmp/storage-a';
    const first = new Store(db, '/tmp/storage-a', () => future);
    const existing = first.createProject({
      name: 'existing',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const adopted = first.createProject({
      name: 'adopted',
      description: '',
      model: null,
      permissionMode: 'default',
      adopt: { repoPath: '/tmp/user-repo', sourcePath: '/tmp/user-repo', protectedBranch: 'main' },
    });
    // Simulate pre-migration rows, then select a new root before opening the store.
    db.exec('UPDATE project SET scratch_path = NULL');
    future = '/tmp/storage-b';
    const store = new Store(db, '/tmp/storage-a', () => future);
    const next = store.createProject({
      name: 'next',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    assert.equal(next.repo_path, join(future, next.id, 'repo.git'));
    for (const project of [existing, adopted]) {
      const expected = join('/tmp/storage-a', project.id);
      assert.equal(store.projectScratchDir(project.id), expected);
      const node = store.createNode({
        projectId: project.id,
        parentId: null,
        displayName: 'master',
        description: '',
      });
      assert.equal(node.worktree_path, join(expected, 'worktrees', node.id));
    }
    const reopened = new Store(db, '/tmp/another-startup-root', () => '/tmp/storage-c');
    assert.equal(reopened.projectScratchDir(existing.id), join('/tmp/storage-a', existing.id));
    assert.equal(reopened.projectScratchDir(adopted.id), join('/tmp/storage-a', adopted.id));
    assert.equal(reopened.projectScratchDir(next.id), join('/tmp/storage-b', next.id));
  } finally {
    db.close();
  }
});

test('text size survives settings reload and old settings use the standard size', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bonsai-text-size-'));
  try {
    const config = {
      port: 0,
      dataDir: dir,
      reposRoot: join(dir, 'repos'),
      defaultModel: null,
      defaultPermissionMode: 'default' as const,
    };
    const settings = new Settings(config);
    assert.equal(settings.view().textScale, 100);
    settings.update({ textScale: 130 });
    assert.equal(new Settings(config).view().textScale, 130);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
