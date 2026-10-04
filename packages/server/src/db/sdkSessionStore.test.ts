import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { forkSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { openDatabase, openInMemory } from './open.js';
import { SdkSessionStore } from './sdkSessionStore.js';
import { Store } from './store.js';

test('SDK mirror survives reopen and a WAL-safe backup; replay cannot rewrite a completed checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bonsai-sdk-store-'));
  let db = openDatabase(root);
  try {
    let store = new SdkSessionStore(db);
    const key = { projectKey: 'old-folder', sessionId: randomUUID() };
    await store.append(key, [{ type: 'user', uuid: 'first', message: { content: 'saved' } }]);
    const boundary = store.checkpoint(key.sessionId)!;
    await store.append(key, [{ type: 'user', uuid: 'first', message: { content: 'rewritten' } }]);
    await store.append(key, [{ type: 'assistant', uuid: 'second', message: { content: 'later' } }]);
    assert.equal((await store.at(key.sessionId, boundary).load(key))!.length, 1);
    const circular: { type: string; [key: string]: unknown } = { type: 'assistant' };
    circular['loop'] = circular;
    await assert.rejects(
      store.append(key, [{ type: 'user', uuid: 'rollback' }, circular]),
      /circular/,
    );
    assert.equal((await store.load(key))!.length, 2, 'a failed batch rolls back every entry');
    const snapshot = join(root, 'verified.db');
    db.prepare('VACUUM INTO ?').run(snapshot);
    db.close();
    db = openDatabase(root);
    store = new SdkSessionStore(db);
    const entries = await store.load({ ...key, projectKey: 'moved-folder' });
    assert.equal(entries!.length, 2);
    assert.deepEqual(entries![0]!['message'], { content: 'saved' });
    const backup = new DatabaseSync(snapshot);
    try {
      assert.deepEqual(await new SdkSessionStore(backup).load(key), entries);
    } finally {
      backup.close();
    }
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('official SDK fork at a completed checkpoint excludes unfinished root and subagent turns without a message cut point', async () => {
  const db = openInMemory();
  const root = await mkdtemp(join(tmpdir(), 'bonsai-sdk-fork-'));
  try {
    const store = new SdkSessionStore(db);
    const key = { projectKey: root.replace(/[^a-zA-Z0-9]/g, '-'), sessionId: randomUUID() };
    const first = randomUUID();
    const answer = randomUUID();
    const base = {
      sessionId: key.sessionId,
      cwd: root,
      timestamp: new Date().toISOString(),
      isSidechain: false,
    };
    await store.append(key, [
      {
        ...base,
        type: 'user',
        uuid: first,
        parentUuid: null,
        message: { role: 'user', content: 'finished request' },
      },
      {
        ...base,
        type: 'assistant',
        uuid: answer,
        parentUuid: first,
        message: { role: 'assistant', content: [{ type: 'text', text: 'finished answer' }] },
      },
    ]);
    await store.append({ ...key, subpath: 'subagents/agent-finished.jsonl' }, [
      { type: 'user', uuid: randomUUID(), message: { content: 'finished subagent' } },
    ]);
    const boundary = store.checkpoint(key.sessionId)!;
    await store.append(key, [
      {
        ...base,
        type: 'user',
        uuid: randomUUID(),
        parentUuid: answer,
        message: { role: 'user', content: 'unfinished request' },
      },
    ]);
    await store.append({ ...key, subpath: 'subagents/agent-unfinished.jsonl' }, [
      { type: 'user', uuid: randomUUID(), message: { content: 'unfinished subagent' } },
    ]);
    const view = store.at(key.sessionId, boundary);
    assert.deepEqual(await view.listSubkeys!(key), ['subagents/agent-finished.jsonl']);
    const fork = await forkSession(key.sessionId, { dir: root, sessionStore: view });
    const messages = await getSessionMessages(fork.sessionId, { dir: root, sessionStore: store });
    assert.equal(messages.length, 2);
    assert.match(JSON.stringify(messages), /finished answer/);
    assert.doesNotMatch(JSON.stringify(messages), /unfinished request/);
    assert.notEqual(fork.sessionId, key.sessionId);
    assert.equal(
      (await store.load({ ...key, sessionId: fork.sessionId }))!.filter((e) => e.type === 'user')
        .length,
      1,
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('deletion removes every owned SDK session and seed atomically, while archives and other owners keep theirs', async () => {
  const db = openInMemory();
  try {
    const store = new Store(db, '/tmp/bonsai-session-owners');
    const project = store.createProject({
      name: 'owners',
      description: '',
      model: null,
      permissionMode: 'acceptEdits',
    });
    const master = store.createNode({
      projectId: project.id,
      parentId: null,
      displayName: 'main',
      description: '',
      rootCommit: 'fixture-root-commit',
    });
    const a = store.createNode({
      projectId: project.id,
      parentId: master.id,
      displayName: 'a',
      description: '',
    });
    const b = store.createNode({
      projectId: project.id,
      parentId: master.id,
      displayName: 'b',
      description: '',
    });
    const c = store.createNode({
      projectId: project.id,
      parentId: b.id,
      displayName: 'copied',
      description: '',
    });
    const key = (sessionId: string) => ({ projectKey: 'fixture', sessionId });
    store.setSessionId(a.id, 'old-a');
    await store.sdkSessions.append(key('old-a'), [
      { type: 'user', uuid: 'old', message: { content: 'old private context' } },
    ]);
    store.setSessionId(a.id, 'shared');
    store.setSessionId(b.id, 'shared');
    store.setSessionId(c.id, 'copied');
    await store.sdkSessions.append(key('shared'), [
      { type: 'user', uuid: 'shared', message: { content: 'shared legacy context' } },
    ]);
    await store.sdkSessions.append(key('copied'), [
      { type: 'user', uuid: 'copied', message: { content: 'independent child context' } },
    ]);
    await store.sdkSessions.append({ ...key('copied'), subpath: 'subagents/child.jsonl' }, [
      { type: 'assistant', uuid: 'child-tool' },
    ]);
    store.setMetadata(`conversation_seed:${a.id}`, 'a inherited context');
    store.setMetadata(`session_boundary:${a.id}`, '1');
    store.setMetadata(`conversation_seed:${c.id}`, 'independent fixed context');
    const comparison = store.comparisons.create(project.id, 'shared legacy session', []);
    store.comparisons.setSession(comparison.id, 'shared');
    await store.sdkSessions.append(key('interrupted-fork'), [{ type: 'user', uuid: 'orphan' }]);
    store.sdkSessions.removeUnowned();
    assert.equal(await store.sdkSessions.load(key('interrupted-fork')), null);
    assert.notEqual(await store.sdkSessions.load(key('shared')), null);
    store.markArchived(b.id);
    assert.notEqual(
      await store.sdkSessions.load(key('shared')),
      null,
      'archiving retains session ownership',
    );
    store.deleteNode(a.id);
    assert.equal(
      await store.sdkSessions.load(key('old-a')),
      null,
      'replaced sessions belong to the deleted owner too',
    );
    assert.equal(store.metadata(`conversation_seed:${a.id}`), null);
    assert.equal(store.metadata(`session_boundary:${a.id}`), null);
    assert.notEqual(
      await store.sdkSessions.load(key('shared')),
      null,
      'a live legacy co-owner retains its session',
    );
    assert.notEqual(
      await store.sdkSessions.load(key('copied')),
      null,
      'independent copied sessions survive unrelated deletion',
    );
    db.exec(
      "CREATE TRIGGER fail_sdk_cleanup BEFORE DELETE ON sdk_session WHEN OLD.session_id = 'copied' BEGIN SELECT RAISE(ABORT, 'cleanup fixture'); END",
    );
    assert.throws(() => store.deleteNode(b.id), /cleanup fixture/);
    assert.ok(store.getNode(b.id));
    assert.ok(store.getNode(c.id));
    assert.notEqual(await store.sdkSessions.load(key('copied')), null);
    assert.equal(store.metadata(`conversation_seed:${c.id}`), 'independent fixed context');
    db.exec('DROP TRIGGER fail_sdk_cleanup');
    store.deleteNode(b.id);
    assert.equal(await store.sdkSessions.load(key('copied')), null);
    assert.equal(
      await store.sdkSessions.load({ ...key('copied'), subpath: 'subagents/child.jsonl' }),
      null,
    );
    assert.equal(store.metadata(`conversation_seed:${c.id}`), null);
    assert.notEqual(
      await store.sdkSessions.load(key('shared')),
      null,
      'a remaining comparison is still an owner',
    );
    store.comparisons.delete(comparison.id);
    assert.equal(await store.sdkSessions.load(key('shared')), null);
    store.deleteProject(project.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sdk_session_owner').get()!['n'], 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sdk_session_entry').get()!['n'], 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('upgrading the first mirrored schema backfills ownership without losing its transcript and removes deleted seeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bonsai-sdk-owner-migration-'));
  let db = openDatabase(root);
  try {
    let store = new Store(db, root);
    const project = store.createProject({
      name: 'old mirror',
      description: '',
      model: null,
      permissionMode: 'acceptEdits',
    });
    const node = store.createNode({
      projectId: project.id,
      parentId: null,
      displayName: 'old node',
      description: '',
    });
    store.setSessionId(node.id, 'existing-mirror');
    await store.sdkSessions.append({ projectKey: 'fixture', sessionId: 'existing-mirror' }, [
      { type: 'user', uuid: 'old', message: { content: 'existing owned history' } },
    ]);
    store.setMetadata('conversation_seed:deleted-owner', 'previously leaked context');
    db.exec(
      'DROP TRIGGER sdk_session_owner_delete; DROP TRIGGER node_sdk_session_insert; DROP TRIGGER node_sdk_session_update; DROP TRIGGER comparison_sdk_session_insert; DROP TRIGGER comparison_sdk_session_update; DROP TRIGGER node_conversation_metadata_delete; DELETE FROM sdk_session_owner; DROP TABLE sdk_session_owner',
    );
    store.setMetadata('schema_version', '26');
    db.close();
    db = openDatabase(root);
    store = new Store(db, root);
    store.sdkSessions.removeUnowned();
    assert.equal(
      (await store.sdkSessions.load({ projectKey: 'moved', sessionId: 'existing-mirror' }))!.length,
      1,
    );
    assert.equal(store.metadata('conversation_seed:deleted-owner'), null);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM sdk_session_owner WHERE node_id = ?').get(node.id)![
        'n'
      ],
      1,
    );
    store.deleteNode(node.id);
    assert.equal(
      await store.sdkSessions.load({ projectKey: 'fixture', sessionId: 'existing-mirror' }),
      null,
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
