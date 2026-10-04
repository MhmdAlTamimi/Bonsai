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
