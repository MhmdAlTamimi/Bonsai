import { createAllocatedChild as createChildNode } from '../testing/allocatedChild.js';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { adoptProject, createProject } from '../projects.js';
import { commitRunOutput } from '../git/commit.js';
import { git, gitLine } from '../git/exec.js';
import { runCommand } from '../exec/command.js';
import { shellPath, writeApplyPatch } from './applyPatch.js';
import { branchOf, nodeRef } from '../git/refs.js';

/**
 * The command that takes an experiment's changes to your own repository.
 *
 * Every test RUNS the command, in a folder standing in for yours, because a
 * string that exists to be pasted into a terminal is only right if it works
 * there.
 */
describe('the apply command', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;
  let patches: string;

  beforeEach(async () => {
    // As git spells it, which on Windows is not how the temp folder is spelt.
    root = await realpath(await mkdtemp(join(tmpdir(), 'bonsai-apply-')));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
    patches = join(root, 'data', 'patches');
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  /** Commits files in a node the way a run does, notes included. */
  async function commit(nodeId: string, files: Record<string, string>): Promise<void> {
    const node = store.getNode(nodeId)!;
    const project = store.getProject(node.project_id)!;
    for (const [path, content] of Object.entries(files)) {
      const destination = join(
        node.worktree_path,
        path === 'CONTEXT.md' ? project.notes_path! : path,
      );
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, 'utf8');
    }
    const outcome = await commitRunOutput({
      repoPath: store.getProject(node.project_id)!.repo_path,
      worktreePath: node.worktree_path,
      branchName: branchOf(node),
      ref: nodeRef(node.project_id, nodeId),
      message: 'work',
      baseCommit: node.base_commit,
      contextFile: project.notes_path,
    });
    store.recordCommit(nodeId, outcome.branch!, outcome.commit!);
  }

  async function mine(name = 'mine'): Promise<string> {
    const folder = join(root, name);
    await git(['init', '--initial-branch=main', folder], root);
    await git(['config', 'user.email', 'a@b.c'], folder);
    await git(['config', 'user.name', 'A'], folder);
    await writeFile(join(folder, 'app.txt'), 'one\ntwo\nthree\nfour\nfive\n', 'utf8');
    await git(['add', '-A'], folder);
    await git(['commit', '-m', 'first'], folder);
    return folder;
  }

  const run = (command: string, cwd: string) => runCommand({ command, cwd, timeoutMs: 30_000 });

  /**
   * A file the command wrote, with LF line endings. It runs your git, with
   * your settings: on Windows those usually check files out with CRLF.
   */
  const text = async (path: string): Promise<string> =>
    (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');

  test('applies to your folder uncommitted, without Bonsai’s notes, after your code moved on', async () => {
    const folder = await mine();
    const adopted = await adoptProject(store, {
      path: folder,
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const { nodeId } = await createChildNode(store, {
      projectId: adopted.projectId,
      parentId: adopted.masterNodeId,
      displayName: 'try Redis',
      description: '',
    });
    await commit(nodeId, {
      'app.txt': 'ONE\ntwo\nthree\nfour\nfive\n',
      'cache.txt': 'redis\n',
      'CONTEXT.md': '# notes\n',
    });
    // You kept working on a different line after the experiment started.
    await writeFile(join(folder, 'app.txt'), 'one\ntwo\nthree\nfour\nFIVE\n', 'utf8');
    await git(['commit', '-am', 'mine'], folder);
    const head = await gitLine(['rev-parse', 'HEAD'], folder);

    // User display preferences must never alter the machine-generated patch.
    await git(['config', 'diff.noprefix', 'true'], folder);
    await git(['config', 'diff.mnemonicPrefix', 'true'], folder);

    const patch = await writeApplyPatch(store, store.getNode(nodeId)!, patches);
    assert.deepEqual([patch.files, patch.added, patch.removed], [2, 2, 1]);
    assert.match(patch.path, /try-redis-[0-9a-f]{7}-line-[0-9a-f-]+\.patch$/);
    assert.equal(patch.behind, null);

    const result = await run(patch.command, folder);
    assert.equal(result.ok, true, `${patch.command}\n${result.stderr}`);
    assert.equal(await text(join(folder, 'app.txt')), 'ONE\ntwo\nthree\nfour\nFIVE\n');
    assert.equal(await text(join(folder, 'cache.txt')), 'redis\n');
    await assert.rejects(readFile(join(folder, 'CONTEXT.md')), { code: 'ENOENT' });
    // Nothing committed: that is yours to do.
    assert.equal(await gitLine(['rev-parse', 'HEAD'], folder), head);
  });

  test('works for a folder whose name a shell would otherwise read', async () => {
    // Legal on Linux, macOS and Windows alike, and each character means
    // something to some shell: a space, a quote, a variable, a command
    // separator and bash's history expansion.
    const folder = await mine("my repo's $HOME & !x");
    const adopted = await adoptProject(store, {
      path: folder,
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const { nodeId } = await createChildNode(store, {
      projectId: adopted.projectId,
      parentId: adopted.masterNodeId,
      displayName: 'rename',
      description: '',
    });
    await commit(nodeId, { 'app.txt': 'ONE\ntwo\nthree\nfour\nfive\n' });

    // Run through this platform's shell (sh, or cmd.exe on Windows), from
    // elsewhere, as it would be pasted.
    const patch = await writeApplyPatch(store, store.getNode(nodeId)!, patches);
    const result = await run(patch.command, root);
    assert.equal(result.ok, true, `${patch.command}\n${result.stderr}`);
    assert.match(await text(join(folder, 'app.txt')), /^ONE\ntwo/);
  });

  test('applies to a checkout with Windows line endings, changing only what changed', async () => {
    // core.autocrlf=true, as Git for Windows usually sets it: the files in
    // your folder end their lines in CRLF, and the repository stores LF.
    const folder = await mine();
    await git(['config', 'core.autocrlf', 'true'], folder);
    await rm(join(folder, 'app.txt'));
    await git(['checkout', '--', 'app.txt'], folder);
    assert.equal(
      await readFile(join(folder, 'app.txt'), 'utf8'),
      'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n',
    );

    const adopted = await adoptProject(store, {
      path: folder,
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const { nodeId } = await createChildNode(store, {
      projectId: adopted.projectId,
      parentId: adopted.masterNodeId,
      displayName: 'shout',
      description: '',
    });
    await commit(nodeId, { 'app.txt': 'one\r\nTWO\r\nthree\r\nfour\r\nfive\r\n' });

    const patch = await writeApplyPatch(store, store.getNode(nodeId)!, patches);
    assert.deepEqual([patch.files, patch.added, patch.removed], [1, 1, 1]);
    const result = await run(patch.command, folder);
    assert.equal(result.ok, true, `${patch.command}\n${result.stderr}`);
    assert.equal(
      await readFile(join(folder, 'app.txt'), 'utf8'),
      'one\r\nTWO\r\nthree\r\nfour\r\nfive\r\n',
    );
    // One line changed, not every line's ending.
    assert.equal((await git(['diff', '--staged', '--numstat'], folder)).trim(), '1\t1\tapp.txt');
  });

  test('quotes a path for the terminal it will be pasted into', () => {
    assert.equal(shellPath('/home/me/repo', 'linux'), '/home/me/repo');
    assert.equal(
      shellPath('/Users/me/Library/Application Support/Bonsai/x.patch', 'darwin'),
      "'/Users/me/Library/Application Support/Bonsai/x.patch'",
    );
    assert.equal(shellPath("/home/me/it's $HOME", 'linux'), `'/home/me/it'\\''s $HOME'`);
    // Windows: forward slashes, which git takes and no shell there escapes.
    assert.equal(shellPath('C:\\Users\\me\\repo', 'win32'), '"C:/Users/me/repo"');
    assert.equal(shellPath('D:\\', 'win32'), '"D:/"');
    assert.equal(shellPath('\\\\server\\share\\repo', 'win32'), '"//server/share/repo"');
  });

  test('a grandchild applies its whole line, from any folder, and its own step only when asked', async () => {
    const folder = await mine();
    const adopted = await adoptProject(store, {
      path: folder,
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const a = await createChildNode(store, {
      projectId: adopted.projectId,
      parentId: adopted.masterNodeId,
      displayName: 'add login',
      description: '',
    });
    await commit(a.nodeId, { 'login.py': 'def login(): pass\n', 'util.py': 'x = 1\n' });
    const b = await createChildNode(store, {
      projectId: adopted.projectId,
      parentId: a.nodeId,
      displayName: 'improve login',
      description: '',
    });
    await commit(b.nodeId, { 'login.py': 'def login(user):\n    return user\n' });

    // B's own step modifies a file only A added: alone, it cannot apply.
    const own = await writeApplyPatch(store, store.getNode(b.nodeId)!, patches, 'own');
    assert.deepEqual([own.scope, own.files, own.scopes], ['own', 1, { own: 1, line: 2 }]);
    const savedOwn = await readFile(own.path, 'utf8');
    assert.equal((await run(own.command, root)).ok, false);

    // The whole line is the default, names your folder, and works from anywhere.
    const line = await writeApplyPatch(store, store.getNode(b.nodeId)!, patches);
    assert.deepEqual([line.scope, line.files, line.folder], ['line', 2, folder]);
    assert.notEqual(own.path, line.path);
    assert.equal(await readFile(own.path, 'utf8'), savedOwn);
    assert.ok(line.command.startsWith(`git -C ${shellPath(folder)} apply --3way `), line.command);
    const result = await run(line.command, root);
    assert.equal(result.ok, true, `${line.command}\n${result.stderr}`);
    assert.equal(await text(join(folder, 'login.py')), 'def login(user):\n    return user\n');
    assert.equal(await text(join(folder, 'util.py')), 'x = 1\n');

    // Master's direct child has one step: nothing to choose between.
    assert.equal((await writeApplyPatch(store, store.getNode(a.nodeId)!, patches)).scopes, null);
  });

  test('says when your folder is on another branch than the project started from', async () => {
    const folder = await mine();
    const adopted = await adoptProject(store, {
      path: folder,
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const { nodeId } = await createChildNode(store, {
      projectId: adopted.projectId,
      parentId: adopted.masterNodeId,
      displayName: 'change',
      description: '',
    });
    await commit(nodeId, { 'app.txt': 'ONE\ntwo\nthree\nfour\nfive\n' });
    assert.equal(
      (await writeApplyPatch(store, store.getNode(nodeId)!, patches)).branchMismatch,
      null,
    );
    await git(['switch', '-c', 'elsewhere'], folder);
    assert.deepEqual(
      (await writeApplyPatch(store, store.getNode(nodeId)!, patches)).branchMismatch,
      { startedFrom: 'main', folderOn: 'elsewhere' },
    );
  });

  test('never overwrites a file you are still editing', async () => {
    const folder = await mine();
    const adopted = await adoptProject(store, {
      path: folder,
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const { nodeId } = await createChildNode(store, {
      projectId: adopted.projectId,
      parentId: adopted.masterNodeId,
      displayName: 'edit',
      description: '',
    });
    await commit(nodeId, { 'app.txt': 'ONE\ntwo\nthree\nfour\nfive\n' });
    await writeFile(join(folder, 'app.txt'), 'one\ntwo\nmy unsaved edit\nfour\nfive\n', 'utf8');

    const patch = await writeApplyPatch(store, store.getNode(nodeId)!, patches);
    const result = await run(patch.command, folder);
    assert.equal(result.ok, false);
    assert.equal(
      await readFile(join(folder, 'app.txt'), 'utf8'),
      'one\ntwo\nmy unsaved edit\nfour\nfive\n',
    );
  });

  test('works for a project Bonsai created, and says when the experiment is behind', async () => {
    const created = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    await commit(created.masterNodeId, { 'app.txt': 'base\n' });
    const { nodeId } = await createChildNode(store, {
      projectId: created.projectId,
      parentId: created.masterNodeId,
      displayName: 'child',
      description: '',
    });
    await assert.rejects(writeApplyPatch(store, store.getNode(nodeId)!, patches), {
      status: 409,
    });
    await commit(nodeId, { 'feature.txt': 'feature\n' });
    await commit(created.masterNodeId, { 'app.txt': 'base, improved\n' });

    const patch = await writeApplyPatch(store, store.getNode(nodeId)!, patches);
    assert.deepEqual(patch.behind, {
      commits: 1,
      parentId: created.masterNodeId,
      parentName: 'master',
    });
    // The card says so too, without asking git.
    const card = store.treeView(created.projectId).find((n) => n.id === nodeId)!;
    assert.deepEqual(card.behind, { parentId: created.masterNodeId, parentName: 'master' });
    const master = store.treeView(created.projectId).find((n) => n.id === created.masterNodeId)!;
    assert.equal(master.behind, null);

    // Any clone stands in for "your repository" here.
    const clone = join(root, 'clone');
    await git(['clone', store.getProject(created.projectId)!.repo_path, clone], root);
    const result = await run(patch.command, clone);
    assert.equal(result.ok, true, result.stderr);
    assert.equal(await text(join(clone, 'feature.txt')), 'feature\n');
  });
});
