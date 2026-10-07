import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { OperationConflict } from '../domain/errors.js';

/** Working bytes, modes and literal symlinks; copies may have a more private root mode. */
export async function fingerprint(
  root: string,
  mode: 'working' | 'raw' | 'git' | 'local' = 'working',
): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (path: string): Promise<void> => {
    const info = await lstat(path);
    hash.update(relative(root, path) + '\0' + (path === root ? '' : info.mode) + '\0');
    if (info.isSymbolicLink()) hash.update(await readlink(path));
    else if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) {
        if (mode === 'working' && entry === '.git') continue;
        if (mode === 'raw' && path === root && entry === '.git') continue;
        if (mode === 'git' && entry.endsWith('.lock'))
          throw new OperationConflict(
            'Git is writing this project. Let it finish before preserving files.',
          );
        await walk(join(path, entry));
      }
    } else if (info.isFile()) {
      for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    } else throw new OperationConflict(`A special filesystem entry cannot be preserved: ${path}`);
    hash.update('\0');
  };
  await walk(root);
  return hash.digest('hex');
}
