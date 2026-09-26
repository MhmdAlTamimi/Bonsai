import { resolve } from 'node:path';
import { diagnosticReport } from '../diagnosticPrivacy.js';
import type { UpdateSettingsRequest } from '@bonsai/shared';
import { TEXT_SCALES } from '@bonsai/shared';
import type { DiagnosticsView, DirectoryInspectionView } from '@bonsai/shared';
import { inspectDirectory } from '../../git/adopt.js';
import { listDirectory } from '../browse.js';
import { revealInFileManager } from '../reveal.js';
import { HttpError, readJson, requireString, sendJson } from '../http.js';
import { FileLogger } from '../../log.js';
import { storageUse } from '../../archive.js';
import { route } from '../routing.js';

/** Connection, settings, diagnostics and the local filesystem. */

route('GET', '/api/connection', (_req, res, _p, { connection }) => {
  sendJson(res, 200, connection.current());
});

route('POST', '/api/connection/check', async (_req, res, _p, { connection }) => {
  sendJson(res, 200, await connection.check());
});

route('POST', '/api/connection/login', async (_req, res, _p, { connection }) => {
  const result = await connection.login();
  // Whether it worked is decided by a fresh probe, not by the exit code.
  const status = await connection.check();
  sendJson(res, 200, { ...result, status });
});

route('GET', '/api/browse', async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  sendJson(res, 200, await listDirectory(url.searchParams.get('path') ?? undefined));
});

/**
 * Looks at a folder without changing it, so the UI can warn before adopting.
 *
 * The database is asked FIRST, and that order is the whole point. Bonsai
 * creates worktrees and then cannot recognise them: pointing the picker at one
 * used to reach git, which answered with a sentence about linked worktrees and
 * advice ("choose that repository instead") that leads to a bare repo nobody
 * can adopt. Bonsai already knew the answer -- the path was sitting in its own
 * node table -- so it says which node it is and lets the interface offer to
 * open it.
 *
 * The lookup lives here rather than in git/adopt.ts because that module shells
 * out to git and must not grow a database dependency.
 */
route('POST', '/api/inspect', async (req, res, _p, { store }) => {
  const body = await readJson<{ path?: string }>(req);
  const path = requireString(body.path, 'path');

  const owner = store.findFolderOwner(path);
  if (
    owner !== null &&
    owner.project.source_kind === 'adopted' &&
    owner.node?.parent_id == null &&
    resolve(path) === resolve(owner.project.source_path ?? owner.project.repo_path)
  ) {
    // The shared original checkout can host several independently named projects.
    sendJson(res, 200, { ...(await inspectDirectory(path)), knownTo: null });
    return;
  }
  if (owner !== null) {
    const { project, node } = owner;
    const what =
      node === null
        ? `part of your project ${project.name}`
        : `the node ${node.display_name} in your project ${project.name}`;
    const view: DirectoryInspectionView = {
      path,
      exists: true,
      isDirectory: true,
      isGitRepo: true,
      branch: null,
      headCommit: null,
      dirtyFiles: 0,
      entryCount: 0,
      repoRoot: null,
      workDir: '',
      blockedReason: `This folder is ${what}. It is already in Bonsai.`,
      knownTo: {
        projectId: project.id,
        projectName: project.name,
        nodeId: node?.id ?? null,
        nodeName: node?.display_name ?? null,
      },
    };
    sendJson(res, 200, view);
    return;
  }

  sendJson(res, 200, { ...(await inspectDirectory(path)), knownTo: null });
});

/**
 * Everything needed to investigate a problem, in one response.
 *
 * The alternative is a conversation -- what version, what platform, where is
 * your data directory, what does the log say -- and every round of that is a
 * day. Assembled here because most of it is not in the contract and should not
 * be: versions, paths and log lines are the server's business.
 *
 * The API key is not here and cannot be. Only whether one is stored, which is
 * the part that changes behaviour.
 */
route('GET', '/api/diagnostics', (req, res, _p, { store, settings, connection, jobs, log }) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const nodeId = url.searchParams.get('nodeId');
  const row = nodeId === null ? undefined : store.getNode(nodeId);
  const view =
    row === undefined ? undefined : store.treeView(row.project_id).find((n) => n.id === row.id);

  const settingsView = settings.view();
  const body: DiagnosticsView = {
    generatedAt: new Date().toISOString(),
    app: { node: process.version, platform: process.platform, arch: process.arch },
    paths: {
      dataDir: settingsView.dataDir,
      reposRoot: settingsView.reposRoot,
      logDir: log instanceof FileLogger ? log.directory() : '(not a file logger)',
    },
    agent: {
      authMode: settingsView.authMode,
      hasStoredApiKey: settingsView.hasStoredApiKey,
      model: settingsView.model,
      effort: settingsView.effort,
      permissionMode: settingsView.permissionMode,
      standIn: process.env['BONSAI_FAKE_AGENT'] === '1',
    },
    connection: connection.current(),
    counts: { ...store.counts(), running: jobs.activeCount() },
    log: log instanceof FileLogger ? log.tail(50) : [],
    node:
      view === undefined
        ? null
        : {
            id: view.id,
            displayName: view.displayName,
            status: view.status,
            writable: view.writable,
            frozenReason: view.frozenReason,
            runs: store.listRuns(view.id),
          },
  };
  sendJson(
    res,
    200,
    diagnosticReport(
      body,
      Object.values(settings.agentEnv() ?? {}).filter((value) => value !== ''),
    ),
  );
});

/** What experiment folders take up on disk. Walks them, so it is asked for, not pushed. */
route('GET', '/api/storage', async (_req, res, _p, { store }) => {
  sendJson(res, 200, await storageUse(store));
});

route('GET', '/api/settings', (_req, res, _p, { settings }) => {
  sendJson(res, 200, settings.view());
});

route('PATCH', '/api/settings', async (req, res, _p, { settings, connection, store, bus }) => {
  const body = await readJson<UpdateSettingsRequest>(req);
  if (body.authMode !== undefined && !['cli', 'api_key'].includes(body.authMode))
    throw new HttpError(400, 'Choose a sign-in method.');
  for (const field of ['apiKey', 'model', 'effort', 'reposRoot'] as const) {
    if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string')
      throw new HttpError(400, `${field} must be text.`);
  }
  if (body.apiKey === null || body.reposRoot === null)
    throw new HttpError(400, 'Key and folder must be text.');
  if (
    body.permissionMode !== undefined &&
    !['default', 'acceptEdits', 'bypassPermissions', 'plan'].includes(body.permissionMode)
  )
    throw new HttpError(400, 'Choose a supported permission mode.');
  if (
    body.effort !== undefined &&
    body.effort !== null &&
    !['low', 'medium', 'high', 'xhigh', 'max'].includes(body.effort)
  )
    throw new HttpError(400, 'Choose a supported effort.');
  for (const field of ['panelWidth', 'maxConcurrentRuns'] as const) {
    if (
      body[field] !== undefined &&
      (typeof body[field] !== 'number' || !Number.isFinite(body[field]))
    )
      throw new HttpError(400, `${field} must be a number.`);
  }
  if (
    body.archiveAfterDays !== undefined &&
    body.archiveAfterDays !== null &&
    (typeof body.archiveAfterDays !== 'number' || !Number.isFinite(body.archiveAfterDays))
  )
    throw new HttpError(400, 'archiveAfterDays must be a number of days, or null.');
  if (body.wrapLines !== undefined && typeof body.wrapLines !== 'boolean')
    throw new HttpError(400, 'wrapLines must be boolean.');
  if (body.textScale !== undefined && !TEXT_SCALES.some((scale) => scale === body.textScale))
    throw new HttpError(400, 'Choose a supported text size.');
  const view = settings.update(body);
  // Auth-affecting changes invalidate what we know, so re-check immediately.
  if (body.authMode !== undefined || body.apiKey !== undefined || body.model !== undefined) {
    await connection.check();
  }
  for (const project of store.listProjects())
    bus.publish(project.id, { type: 'tree.updated', projectId: project.id });
  sendJson(res, 200, view);
});

route('POST', '/api/reveal', async (req, res) => {
  const body = await readJson<{ path?: string }>(req);
  await revealInFileManager(requireString(body.path, 'path'));
  sendJson(res, 200, { ok: true });
});
