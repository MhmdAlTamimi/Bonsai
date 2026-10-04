import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileName } from '../fileName.js';
import { git, gitLine } from './exec.js';
import { deleteRef, pinRef } from './refs.js';

/** A real repository with its own objects, index and history; no links to Bonsai's Git metadata. */
export async function exportRepository(repo: string, commit: string, into: string): Promise<void> {
  const ref = `refs/bonsai-exports/${randomUUID()}`;
  const bundle = `${into}.bundle`;
  await pinRef(repo, ref, commit);
  try {
    await git(['bundle', 'create', bundle, ref], repo);
    await mkdir(into, { recursive: true });
    await git(['init', '--initial-branch=bonsai-export-unborn'], into);
    await git(['fetch', '--no-tags', bundle, `${ref}:refs/heads/main`], into);
    await git(['checkout', 'main'], into);
    // Relative submodule URLs must resolve against the original remote, never
    // against the temporary bundle. No source remote is retained in the export.
    const modules = await git(['ls-files', '--', '.gitmodules'], into);
    if (modules.trim() !== '') {
      let origin: string | null = null;
      try {
        origin = await gitLine(['remote', 'get-url', 'origin'], repo);
      } catch {
        /* no remote */
      }
      if (origin !== null) await git(['remote', 'add', 'origin', origin], into);
      try {
        await git(['submodule', 'update', '--init', '--recursive'], into);
      } finally {
        if (origin !== null) await git(['remote', 'remove', 'origin'], into);
      }
    }
    await git(['fsck', '--no-dangling'], into);
  } finally {
    await rm(bundle, { force: true });
    await deleteRef(repo, ref, commit);
  }
}

export async function exportExperiment(
  repo: string,
  commit: string,
  root: string,
  name: string,
): Promise<string> {
  await mkdir(root, { recursive: true });
  const folder = await mkdtemp(
    join(root, `${fileName(name, 'experiment')}-${commit.slice(0, 7)}-`),
  );
  try {
    await exportRepository(repo, commit, folder);
  } catch (error) {
    throw new Error(`Export could not finish. Its folder is kept at ${folder}. ${String(error)}`);
  }
  return folder;
}

/** Preserve ignored files too. Git administrative files must never alias the source checkout. */
export async function copyWorkingFiles(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source)) {
    if (entry === '.git') continue;
    await cp(join(source, entry), join(target, entry), {
      recursive: true,
      force: true,
      dereference: false,
      preserveTimestamps: true,
      filter: (path) => basename(path) !== '.git',
    });
  }
}

/** All distinct tips, including staged-only content, stay recoverable in the independent copy. */
export async function protectExportTips(
  folder: string,
  repo: string,
  tips: Record<string, string | null>,
): Promise<void> {
  for (const [name, tip] of Object.entries(tips)) {
    if (tip === null) continue;
    const ref = `refs/bonsai-exports/${randomUUID()}`;
    await pinRef(repo, ref, tip);
    const bundle = join(folder, `${name}.bundle`);
    try {
      await git(['bundle', 'create', bundle, ref], repo);
      await git(['fetch', '--no-tags', bundle, `${ref}:refs/heads/preserved-${name}`], folder);
    } finally {
      await rm(bundle, { force: true });
      await deleteRef(repo, ref, tip);
    }
  }
  await writeFile(`${folder}.json`, JSON.stringify({ tips }, null, 2) + '\n');
}
