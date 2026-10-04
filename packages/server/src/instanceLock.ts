import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class AlreadyRunningError extends Error {
  constructor(readonly url: string | null) {
    super(`Bonsai is already running${url === null ? ' with this data folder' : ` at ${url}`}.`);
  }
}

/**
 * SQLite holds an OS file lock until close or process death, including SIGKILL.
 * This separate database is never the application DB. No PID/stale-lock repair
 * is needed, and aliases of the same data folder contend on the same file.
 */
export function acquireInstanceLock(dataDir: string, port: number): () => void {
  mkdirSync(dataDir, { recursive: true });
  const root = realpathSync(dataDir);
  const addressFile = join(root, 'instance.json');
  const lock = new DatabaseSync(join(root, 'instance.lock.db'));
  try {
    lock.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
  } catch (error) {
    lock.close();
    if (error instanceof Error && /locked|busy/i.test(error.message)) {
      let url: string | null = null;
      try {
        const address = JSON.parse(readFileSync(addressFile, 'utf8')) as { port?: unknown };
        if (
          Number.isInteger(address.port) &&
          Number(address.port) > 0 &&
          Number(address.port) <= 65535
        )
          url = `http://localhost:${Number(address.port)}`;
      } catch {
        // Advisory only: the OS lock, not this metadata, establishes ownership.
      }
      throw new AlreadyRunningError(url);
    }
    throw error;
  }
  try {
    writeFileSync(addressFile, JSON.stringify({ port }), { mode: 0o600 });
  } catch (error) {
    lock.close();
    throw error;
  }
  return () => lock.close();
}
