import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { assertLocalRequest } from './localRequest.js';
import { readJson } from './http.js';
import { ProjectOperations } from './projectOperations.js';
import { EventBus } from './events.js';

test('local API rejects remote origins, opaque origins and DNS rebinding hosts', () => {
  for (const headers of [
    { host: 'example.com' },
    { host: 'localhost:8787', origin: 'https://example.com' },
    { host: '127.0.0.1:8787', origin: 'null' },
  ])
    assert.throws(() => assertLocalRequest(headers), /local applications/);
  assert.doesNotThrow(() =>
    assertLocalRequest({ host: 'localhost:8787', origin: 'http://localhost:5173' }),
  );
  assert.doesNotThrow(() => assertLocalRequest({ host: '127.0.0.1:8787' }));
});

test('JSON request bodies reject non-object payloads before route access', async () => {
  for (const body of ['null', '[]', '42', '"text"', '{'])
    await assert.rejects(readJson(Readable.from([Buffer.from(body)]) as IncomingMessage), /JSON/);
  assert.deepEqual(
    await readJson(Readable.from([Buffer.from('{"name":"safe"}')]) as IncomingMessage),
    { name: 'safe' },
  );
});

test('structural work conflicts only within one project and releases after failure', async () => {
  const operations = new ProjectOperations();
  let release!: () => void;
  const pending = operations.run(
    'a',
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await assert.rejects(
    operations.run('a', () => Promise.resolve(undefined)),
    /creating or deleting/,
  );
  assert.equal(await operations.run('b', () => Promise.resolve('independent')), 'independent');
  release();
  await pending;
  await assert.rejects(
    operations.run('a', () => Promise.reject(new Error('fixture'))),
    /fixture/,
  );
  assert.equal(await operations.run('a', () => Promise.resolve('released')), 'released');
});

test('slow event-stream readers are disconnected without blocking healthy readers', () => {
  class Response extends EventEmitter {
    destroyed = false;
    writableEnded = false;
    writableLength = 0;
    frames: string[] = [];
    writeHead(): void {
      /* Headers are not buffered by this response fixture. */
    }
    write(frame: string): boolean {
      this.frames.push(frame);
      return true;
    }
    destroy(): void {
      this.destroyed = true;
      this.emit('close');
    }
    end(): void {
      this.writableEnded = true;
      this.emit('close');
    }
  }
  const bus = new EventBus();
  const slow = new Response();
  const healthy = new Response();
  bus.subscribe('p', slow as unknown as ServerResponse);
  bus.subscribe('p', healthy as unknown as ServerResponse);
  slow.writableLength = 2_000_000;
  bus.publish('p', { type: 'tree.updated', projectId: 'p' });
  assert.equal(slow.destroyed, true);
  assert.ok(healthy.frames.at(-1)?.includes('tree.updated'));
  bus.closeAll();
  assert.equal(healthy.writableEnded, true);
});
