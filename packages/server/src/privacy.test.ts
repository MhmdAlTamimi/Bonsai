import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './db/open.js';
import { FileLogger } from './log.js';

test('database and logs are private with a permissive umask, and errors redact credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonsai-private-'));
  const old = process.umask(0o022);
  try {
    const data = join(root, 'data');
    const db = openDatabase(data);
    // Keep WAL sidecars alive through another connection, as after an old deployment.
    if (process.platform !== 'win32') {
      const wal = join(data, 'bonsai.db-wal');
      const shm = join(data, 'bonsai.db-shm');
      chmodSync(wal, 0o644);
      chmodSync(shm, 0o644);
      const reopened = openDatabase(data);
      try {
        assert.equal(statSync(wal).mode & 0o777, 0o600);
        assert.equal(statSync(shm).mode & 0o777, 0o600);
      } finally {
        reopened.close();
      }
    }
    db.close();
    const logger = new FileLogger(data);
    logger.error('run.failed', {
      error: 'request rejected: sk-ant-audit-canary Bearer audit-token',
      nested: { apiKey: 'arbitrary-canary', count: 2 },
    });
    const file = join(data, 'logs', readdirSync(join(data, 'logs'))[0]!);
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /audit-canary|audit-token|arbitrary-canary/);
    assert.match(text, /request rejected/);
    if (process.platform !== 'win32') {
      assert.equal(statSync(data).mode & 0o777, 0o700);
      assert.equal(statSync(join(data, 'bonsai.db')).mode & 0o777, 0o600);
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
  } finally {
    process.umask(old);
    rmSync(root, { recursive: true, force: true });
  }
});
