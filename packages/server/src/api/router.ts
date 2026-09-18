import { ProjectOperations } from './projectOperations.js';
import { OperationConflict } from '../domain/errors.js';
import { assertLocalRequest } from './localRequest.js';
import { parseAnswer } from './answers.js';
import { diagnosticReport } from './diagnosticPrivacy.js';
import { resolveRunSettings } from '../jobs/runSettings.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AnswerQuestionRequest,
  CreateNodeRequest,
  CreateProjectRequest,
  NodeDetail,
  RecoverRequest,
  StartRunRequest,
  TreeResponse,
  UpdateNodeRequest,
  UpdateProjectRequest,
  UpdateSettingsRequest,
} from '@bonsai/shared';
import { deriveNodeName, TEXT_SCALES } from '@bonsai/shared';
import type {
  AdoptProjectRequest,
  DiagnosticsView,
  DirectoryInspectionView,
  NodeView,
} from '@bonsai/shared';

import { isUsersOwnCheckout, type Store } from '../db/store.js';
import type { EventBus } from './events.js';
import type { RunJobs } from '../jobs/runNode.js';
import {
  adoptProject,
  createChildNode,
  createProject,
  previewNewDirectory,
  deleteNodeTree,
  deleteProjectTree,
  projectDeletionImpact,
} from '../projects.js';
import { nodeDiff, runDiff, parentSnapshot } from '../git/diff.js';
import { inspectDirectory } from '../git/adopt.js';
import { listDirectory } from './browse.js';
import { rejectPath } from '../git/seedWorktree.js';
import { checkoutFor } from './checkout.js';
import { reviewOf, reviewPatchOf } from './review.js';
import { discardWorktreeChanges, readWorktreeState } from '../git/recovery.js';
import type { Settings } from '../settings.js';
import { Connection } from './connectionGate.js';
import { revealInFileManager } from './reveal.js';
import { readContextFile, testingSection, testingNotesCommit } from '../git/context.js';
import { HttpError, readJson, requireString, sendError, sendJson } from './http.js';
import { FileLogger, type Logger } from '../log.js';

interface Ctx {
  store: Store;
  bus: EventBus;
  jobs: RunJobs;
  settings: Settings;
  connection: Connection;
  log: Logger;
}

/**
 * Anything that would spend money or start an agent requires a working
 * credential. 428 Precondition Required, so the UI can tell this apart from a
 * bug and show the connection screen rather than an error.
 */
/**
 * Stamps each node with what this process is doing with it: its place in the
 * run queue, and what its run is doing right now.
 *
 * Done here rather than in the store because both are facts about this
 * process, not about the tree: the store holds what is true after a restart,
 * and neither survives one. Everything the interface receives goes through
 * this, so a card can never show a stale position or a finished run as live.
 */
function withLive(jobs: RunJobs, nodes: NodeView[]): NodeView[] {
  return nodes.map((n) => ({
    ...n,
    queuePosition: jobs.queuePosition(n.id),
    activity: jobs.activity(n.id),
  }));
}

function requireConnection(connection: Connection): void {
  if (connection.isConnected()) return;
  const status = connection.current();
  throw new HttpError(
    428,
    status.message ??
      'Bonsai is not connected to Claude. Open Settings to sign in or add an API key.',
  );
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  ctx: Ctx,
) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  /** The pattern as written, for logs: '/api/nodes/:id' rather than a uuid. */
  pattern: string;
}

const routes: Route[] = [];
const structure = new ProjectOperations();
function structural(handler: Handler, target: 'node' | 'project'): Handler {
  return async (req, res, params, ctx) => {
    const id = target === 'project' ? params['id'] : ctx.store.getNode(params['id']!)?.project_id;
    if (!id) throw new HttpError(404, 'No such project.');
    await structure.run(id, async () => {
      await handler(req, res, params, ctx);
    });
  };
}

function route(method: string, pattern: string, handler: Handler): void {
  if (
    (method === 'POST' && pattern === '/api/projects/:id/nodes') ||
    (method === 'DELETE' && ['/api/projects/:id', '/api/nodes/:id'].includes(pattern))
  ) {
    handler = structural(handler, pattern === '/api/nodes/:id' ? 'node' : 'project');
  }
  routes.push({ method, segments: pattern.split('/').filter(Boolean), handler, pattern });
}

function match(
  method: string,
  path: string,
): { handler: Handler; params: Record<string, string>; pattern: string } | null {
  const parts = path.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method || r.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < r.segments.length; i += 1) {
      const seg = r.segments[i]!;
      const part = parts[i]!;
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(part);
      else if (seg !== part) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: r.handler, params, pattern: r.pattern };
  }
  return null;
}

// -- connection and settings -------------------------------------------------

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

// -- projects ----------------------------------------------------------------

route('GET', '/api/projects', (_req, res, _p, { store }) => {
  sendJson(
    res,
    200,
    store.listProjects().map((p) => store.projectView(p)),
  );
});

route('POST', '/api/projects/preview', async (req, res) => {
  const body = await readJson<{ location: string; name: string }>(req);
  sendJson(res, 200, {
    path: await previewNewDirectory(
      requireString(body.location, 'location'),
      requireString(body.name, 'name'),
    ),
  });
});

route('POST', '/api/projects', async (req, res, _p, { store, bus, settings, connection }) => {
  requireConnection(connection);
  const body = await readJson<CreateProjectRequest>(req);
  const created = await createProject(store, {
    name: requireString(body.name, 'name'),
    description: typeof body.description === 'string' ? body.description : '',
    model: body.model ?? settings.model(),
    permissionMode: body.permissionMode ?? settings.permissionMode(),
    effort: settings.effort(),
    location: body.location ?? null,
    expectedPath: body.expectedPath,
  });
  bus.publish(created.projectId, { type: 'tree.updated', projectId: created.projectId });
  // D21 has the agent scaffold master from the description; that run starts in
  // M3. The repo, master branch, worktree and root commit all exist now.
  sendJson(res, 201, created);
});

/** Uses a folder the user already has, in place. Nothing is copied or moved. */
route('POST', '/api/projects/adopt', async (req, res, _p, { store, bus, settings, connection }) => {
  requireConnection(connection);
  const body = await readJson<AdoptProjectRequest>(req);
  const created = await adoptProject(store, {
    path: requireString(body.path, 'path'),
    name: body.name,
    description: typeof body.description === 'string' ? body.description : '',
    model: settings.model(),
    permissionMode: settings.permissionMode(),
    effort: settings.effort(),
    includeUncommitted: body.includeUncommitted === true,
  });
  bus.publish(created.projectId, { type: 'tree.updated', projectId: created.projectId });
  sendJson(res, 201, created);
});

route('GET', '/api/projects/:id/tree', (_req, res, params, { store, jobs }) => {
  const project = store.getProject(params['id']!);
  if (project === undefined) throw new HttpError(404, 'no such project');
  const body: TreeResponse = {
    project: store.projectView(project),
    nodes: withLive(jobs, store.treeView(project.id)),
  };
  sendJson(res, 200, body);
});

route('GET', '/api/projects/:id/usage', (_req, res, params, { store }) => {
  const project = store.getProject(params['id']!);
  if (!project) throw new HttpError(404, 'no such project');
  sendJson(res, 200, {
    projectId: project.id,
    experiments: store.listNodes(project.id).map((node) => ({
      id: node.id,
      name: node.display_name,
      runs: store
        .listRuns(node.id)
        .map(
          ({
            id,
            status,
            startedAt,
            model,
            apiKeySource,
            costUsd,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
          }) => ({
            id,
            status,
            startedAt,
            model,
            apiKeySource,
            costUsd,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
          }),
        ),
    })),
  });
});

route('PATCH', '/api/projects/:id', async (req, res, params, { store, bus }) => {
  const project = store.getProject(params['id']!);
  if (project === undefined) throw new HttpError(404, 'no such project');
  const body = await readJson<UpdateProjectRequest>(req);
  if (body.model !== undefined && body.model !== null && typeof body.model !== 'string')
    throw new HttpError(400, 'Model must be a name or App default.');
  if (
    body.effort !== undefined &&
    body.effort !== null &&
    !['low', 'medium', 'high', 'xhigh', 'max'].includes(body.effort)
  )
    throw new HttpError(400, 'Choose a supported effort.');
  if (
    body.permissionMode !== undefined &&
    !['default', 'acceptEdits', 'bypassPermissions', 'plan'].includes(body.permissionMode)
  )
    throw new HttpError(400, 'Choose a supported permission mode.');
  if (
    body.setupCommand !== undefined &&
    body.setupCommand !== null &&
    typeof body.setupCommand !== 'string'
  )
    throw new HttpError(400, 'Setup command must be text.');
  if (
    body.copyFiles !== undefined &&
    (!Array.isArray(body.copyFiles) || !body.copyFiles.every((path) => typeof path === 'string'))
  )
    throw new HttpError(400, 'Files to copy must be a list of paths.');
  if (body.copyFiles !== undefined) {
    /**
     * Refused here rather than at node creation.
     *
     * A path that can never be copied -- node_modules, an absolute path, one
     * that escapes the project -- would otherwise be accepted silently and
     * fail on every node from then on, in a place nobody is looking. Told now,
     * while the user is looking at the field they just typed it into.
     *
     * The tracked-file check is NOT done here: whether a file is tracked is a
     * fact about the repository that can change after this is saved, so it is
     * enforced at copy time and reported with the node.
     */
    const bad = body.copyFiles
      .map((path) => ({ path, reason: rejectPath(path) }))
      .filter((entry): entry is { path: string; reason: string } => entry.reason !== null);
    if (bad.length > 0) {
      throw new HttpError(400, bad.map((b) => `${b.path}: ${b.reason}`).join('; '));
    }
  }
  store.saveProjectConfiguration(project.id, {
    ...body,
    ...(body.copyFiles !== undefined
      ? { copyFiles: body.copyFiles.map((p) => p.trim()).filter(Boolean) }
      : {}),
  });
  bus.publish(project.id, { type: 'tree.updated', projectId: project.id });
  sendJson(res, 200, store.projectView(store.getProject(project.id)!));
});

/** What deleting this project would destroy -- and, when adopted, what it won't. */
route('GET', '/api/projects/:id/deletion-impact', (_req, res, params, { store }) => {
  const impact = projectDeletionImpact(store, params['id']!);
  if (impact === null) throw new HttpError(404, 'no such project');
  sendJson(res, 200, impact);
});

route('DELETE', '/api/projects/:id', async (_req, res, params, { store, bus, jobs }) => {
  const project = store.getProject(params['id']!);
  if (project === undefined) throw new HttpError(404, 'no such project');
  const removed = await jobs.withStoppedNodes(
    store.listNodes(project.id).map((node) => node.id),
    () => deleteProjectTree(store, project.id),
  );
  bus.publish(project.id, { type: 'tree.updated', projectId: project.id });
  sendJson(res, 200, { ok: true, ...removed });
});

// -- nodes -------------------------------------------------------------------

route('POST', '/api/projects/:id/nodes', async (req, res, params, { store, bus, jobs }) => {
  const projectId = params['id']!;
  if (store.getProject(projectId) === undefined) throw new HttpError(404, 'no such project');

  const body = await readJson<CreateNodeRequest>(req);
  const parentId = requireString(body.parentId, 'parentId');
  const parent = store.getNode(parentId);
  if (parent === undefined) throw new HttpError(404, 'no such parent node');
  if (jobs.isRetiring(parent.id)) throw new HttpError(409, 'This experiment is being deleted.');
  if (parent.project_id !== projectId) throw new HttpError(400, 'parent is in another project');

  if (body.sourceVersion !== undefined && body.sourceVersion !== store.childSourceVersion(parent)) {
    throw new HttpError(
      412,
      'The source code changed while this dialog was open. Review the refreshed sources, then create the experiment again.',
    );
  }

  // Note there is no writability check here. Creating a child of a frozen node
  // is legal and normal -- freezing constrains what the *parent* may do next,
  // and it is checked at run start rather than continuously.

  const created = await createChildNode(store, {
    projectId,
    parentId,
    displayName:
      typeof body.displayName === 'string' && body.displayName.trim() !== ''
        ? body.displayName.trim()
        : deriveNodeName(typeof body.description === 'string' ? body.description : ''),
    description: typeof body.description === 'string' ? body.description : '',
    model: body.model ?? null,
    permissionMode: body.permissionMode ?? null,
    // Optional, and deliberately not validated into existence: an empty answer
    // means the node behaves exactly as nodes did before these were asked.
    successCriteria: typeof body.successCriteria === 'string' ? body.successCriteria : null,
    verificationHint: typeof body.verificationHint === 'string' ? body.verificationHint : null,
  });

  bus.publish(projectId, { type: 'tree.updated', projectId });

  // A file that could not be copied is told at the node it affects, not
  // buried in a log: a node missing its .env will fail its checks later for a
  // reason that has nothing to do with the code.
  for (const outcome of created.seeded) {
    if (outcome.copied) continue;
    store.appendMessage({
      nodeId: created.nodeId,
      runId: null,
      role: 'system',
      kind: 'text',
      content: `Could not copy ${outcome.path} into this node: ${outcome.reason ?? 'unknown reason'}`,
    });
  }

  // §6.2: the user stays on the canvas and the node appears immediately. The
  // run is started separately until M3 so the git layer can be driven on its
  // own; `new` is the brief window the state was kept for.
  sendJson(res, 201, {
    node: withLive(jobs, store.treeView(projectId)).find((n) => n.id === created.nodeId),
  });
});

route('GET', '/api/nodes/:id/child-preview', (_req, res, params, { store, jobs, settings }) => {
  const parent = store.getNode(params['id']!);
  if (parent === undefined) throw new HttpError(404, 'no such parent experiment');
  sendJson(res, 200, {
    nextRunSettings: resolveRunSettings(
      { model: null, permission_mode: null },
      store.getProject(parent.project_id)!,
      settings,
    ),
    setup: store.projectView(store.getProject(parent.project_id)!).setup,
    lineage: store.childLineageOf(parent),
    sourceVersion: store.childSourceVersion(parent),
    parentActive: jobs.isRunning(parent.id),
    codeNote: 'Starts from this committed code snapshot. Uncommitted partial work is excluded.',
    conversationNote:
      'The conversation is copied when the new experiment’s first run starts. Later replies stay with their original experiment.',
  });
});

route('GET', '/api/nodes/:id', async (_req, res, params, { store, jobs, settings }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const view = withLive(jobs, store.treeView(row.project_id)).find((n) => n.id === row.id)!;
  const contextMd = await readContextFile(row.worktree_path);
  const project = store.getProject(row.project_id);
  const checkout = checkoutFor(project, row);
  const notes = testingSection(contextMd);
  const sourceCommit = await testingNotesCommit(row.worktree_path, notes);
  const source = sourceCommit === null ? null : store.testingSource(sourceCommit);
  const runs = store.listRuns(row.id);
  const ownFolder = isUsersOwnCheckout(project, row);
  const partialWork = ownFolder ? null : await readWorktreeState(row.worktree_path);
  const body: NodeDetail = {
    nextRunSettings: resolveRunSettings(row, project!, settings),
    node: view,
    runs,
    lineage: store.lineageOf(row),
    checkoutCommand: checkout?.command ?? null,
    checkoutHint: checkout?.hint ?? null,
    successCriteria: row.success_criteria,
    verificationHint: row.verification_hint,
    testingNotes: notes,
    testingSource:
      source === null
        ? null
        : {
            ...source,
            inherited: source.nodeId !== row.id,
            predatesLatestRun: source.runId !== runs.at(-1)?.id,
          },
    partialWork,
    contextMd,
    baseIsPinnedBehindLiveWalk: store.baseDiverges(row),
  };
  sendJson(res, 200, body);
});

route('PATCH', '/api/nodes/:id', async (req, res, params, { store, bus, jobs }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const body = await readJson<UpdateNodeRequest>(req);
  for (const field of ['positionX', 'positionY'] as const) {
    if (
      body[field] !== undefined &&
      body[field] !== null &&
      (typeof body[field] !== 'number' || !Number.isFinite(body[field]))
    )
      throw new HttpError(400, 'Position must be a number or automatic.');
  }
  // D3: nodes are immutable. Display name and canvas position are metadata and
  // are the only things this route will touch.
  store.updateNode(row.id, {
    ...(body.displayName !== undefined
      ? { displayName: requireString(body.displayName, 'displayName') }
      : {}),
    ...(body.positionX !== undefined ? { positionX: body.positionX } : {}),
    ...(body.positionY !== undefined ? { positionY: body.positionY } : {}),
  });
  bus.publish(row.project_id, { type: 'tree.updated', projectId: row.project_id });
  sendJson(
    res,
    200,
    withLive(jobs, store.treeView(row.project_id)).find((n) => n.id === row.id),
  );
});

/** What deleting this node would destroy, so the UI can say so before it does. */
route('GET', '/api/nodes/:id/deletion-impact', (_req, res, params, { store }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const doomed = store.descendantsOf(row.id);
  sendJson(res, 200, {
    nodes: doomed.length,
    names: doomed.map((node) => node.display_name),
    costUsd: store.runs.costOfMany(doomed.map((n) => n.id)),
    commits: doomed.filter((n) => n.head_commit !== null).length,
  });
});

route('DELETE', '/api/nodes/:id', async (_req, res, params, { store, bus, jobs }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  if (row.parent_id === null)
    throw new HttpError(400, 'deleting master means deleting the project');
  // Open Question 3, answered: cancel, then delete. Blocking the delete would
  // strand a node behind a run that may never finish.
  const removed = await jobs.withStoppedNodes(
    store.descendantsOf(row.id).map((node) => node.id),
    () => deleteNodeTree(store, row.id),
  );
  bus.publish(row.project_id, { type: 'tree.updated', projectId: row.project_id });
  sendJson(res, 200, { ok: true, removed });
});

route('GET', '/api/nodes/:id/messages', (req, res, params, { store }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const url = new URL(req.url ?? '/', 'http://localhost');
  const afterSeq = Number(url.searchParams.get('afterSeq') ?? 0);
  sendJson(res, 200, store.listMessages(row.id, Number.isFinite(afterSeq) ? afterSeq : 0));
});

route('GET', '/api/nodes/:id/diff', async (_req, res, params, { store }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const first = store.listRuns(row.id).find((run) => run.commitSha !== null);
  const base =
    row.base_commit ??
    (first?.commitSha != null
      ? await parentSnapshot(row.worktree_path, first.commitSha)
      : row.head_commit);
  if (base === null) throw new HttpError(400, 'No starting code snapshot is available.');
  const diff = await nodeDiff(
    row.worktree_path,
    base,
    row.parent_id === null ? first !== undefined : row.head_commit !== null,
    row.head_commit ?? base,
  );
  const source = store.lineageOf(row).codeFrom;
  sendJson(res, 200, {
    ...diff,
    baseLabel:
      row.parent_id === null
        ? 'The code before this experiment’s first modifying run'
        : `The inherited code snapshot from ${source?.displayName ?? 'its source experiment'}`,
  });
});

/** Review: what this experiment changed, file by file. No patches here. */
route('GET', '/api/nodes/:id/review', async (_req, res, params, { store }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  sendJson(res, 200, await reviewOf(store, row));
});

/** One file's patch, for the pane reading it. */
route('GET', '/api/nodes/:id/review/file', async (req, res, params, { store }) => {
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const path = new URL(req.url ?? '/', 'http://localhost').searchParams.get('path');
  if (path === null || path === '') throw new HttpError(400, 'path is required');
  sendJson(res, 200, await reviewPatchOf(store, row, path));
});

// -- runs --------------------------------------------------------------------

route('POST', '/api/nodes/:id/runs', async (req, res, params, { store, jobs, connection }) => {
  requireConnection(connection);
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const body = await readJson<StartRunRequest>(req);
  try {
    sendJson(res, 202, jobs.start(row.id, requireString(body.prompt, 'prompt')));
  } catch (err) {
    throw new HttpError(409, err instanceof Error ? err.message : String(err));
  }
});

/**
 * Stop whatever this node is doing.
 *
 * Node-shaped, not run-shaped, and that is the fix rather than a convenience.
 * The jobs runner has always cancelled by node -- only the route needed a run
 * id, so the interface had to find the running run first, which it did by
 * searching the panel's fetched detail. Press stop before that detail arrives
 * and the handler found nothing and returned silently while the agent carried
 * on spending money. With no run id required there is nothing to look up and
 * nothing to fail to find.
 *
 * Idempotent: stopping a node that is not running is a 200 with
 * `cancelled: false`, not an error. "It already stopped" is not a failure.
 */
route('POST', '/api/nodes/:id/cancel', (_req, res, params, { store, jobs }) => {
  const node = store.getNode(params['id']!);
  if (node === undefined) throw new HttpError(404, 'no such node');
  sendJson(res, 200, { cancelled: jobs.cancel(node.id) });
});

/**
 * D43: Finish now. The run stops waiting for background work, stops it, and
 * ends normally -- so, unlike cancel, what it produced is committed.
 *
 * Idempotent like cancel: `finished: false` means there was nothing to finish.
 */
route('POST', '/api/nodes/:id/finish', (_req, res, params, { store, jobs }) => {
  const node = store.getNode(params['id']!);
  if (node === undefined) throw new HttpError(404, 'no such node');
  sendJson(res, 200, { finished: jobs.finish(node.id) });
});

/** Stops every run in a project at once, for when several are in flight. */
route('POST', '/api/projects/:id/cancel', (_req, res, params, { store, jobs }) => {
  if (store.getProject(params['id']!) === undefined) throw new HttpError(404, 'no such project');
  let cancelled = 0;
  for (const node of store.listNodes(params['id']!)) {
    if (jobs.cancel(node.id)) cancelled += 1;
  }
  sendJson(res, 200, { cancelled });
});

/** Kept: cancelling a specific run is still meaningful, and nothing has to change. */
route('POST', '/api/runs/:id/cancel', (_req, res, params, { store, jobs }) => {
  const run = store.getRun(params['id']!);
  if (run === undefined) throw new HttpError(404, 'no such run');
  sendJson(res, 200, { cancelled: jobs.cancel(run.node_id) });
});
/**
 * D34: the answer to a question an agent stopped on.
 *
 * Question-shaped rather than node-shaped, unlike cancel. The id is the guard:
 * two windows open on the same node must not answer the same question twice,
 * and a click on a question the run has since moved past has to be refused
 * rather than applied to whatever it is asking now.
 *
 * A refusal carries the user's words to the agent, because the SDK hands a
 * denial's message back as the tool's result. That is the difference between
 * stopping a run and steering it.
 */
route('POST', '/api/questions/:id/answer', async (req, res, params, { store, jobs }) => {
  const question = store.getQuestion(params['id']!);
  if (question === undefined) throw new HttpError(404, 'no such question');

  // Checked against the stored question: the two kinds take different answers,
  // and a mismatch is a bug to surface rather than something to reinterpret.
  const parsed = parseAnswer(question, await readJson<AnswerQuestionRequest>(req));
  const answered =
    parsed.kind === 'permission'
      ? jobs.answer(question.id, parsed.decision)
      : parsed.kind === 'choice'
        ? jobs.answerChoices(question.id, parsed.answers)
        : jobs.leaveToAgent(question.id);
  if (!answered) {
    throw new HttpError(
      409,
      'That question is no longer waiting — it was already answered, or the run has ended.',
    );
  }
  sendJson(res, 200, { ok: true });
});
/** §6.6: resume / discard / keep. */
route('POST', '/api/nodes/:id/recover', async (req, res, params, ctx) => {
  const { store, bus, jobs } = ctx;
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  if (row.status === 'running' || row.status === 'needs_you')
    throw new HttpError(409, 'this node is still running');

  const body = await readJson<RecoverRequest>(req);
  if (jobs.isRunning(row.id)) throw new HttpError(409, 'this node is still running');
  switch (body.action) {
    case 'resume':
      requireConnection(ctx.connection);
      sendJson(res, 202, await jobs.startResume(row.id));
      return;

    case 'discard':
      // Never against the user's own checkout. `git reset --hard` plus
      // `git clean -fd` there would destroy work Bonsai did not create and
      // cannot restore -- an adopted project's master is theirs, not ours.
      if (isUsersOwnCheckout(store.getProject(row.project_id), row)) {
        throw new HttpError(
          400,
          'This node is your own folder. Bonsai will not discard changes there — use git yourself if you want them gone.',
        );
      }
      await discardWorktreeChanges(row.worktree_path);
      store.setNodeStatus(row.id, row.head_commit === null ? 'new' : 'ready');
      bus.publish(row.project_id, { type: 'tree.updated', projectId: row.project_id });
      sendJson(res, 200, { ok: true });
      return;

    case 'keep':
      // Leaves the worktree dirty and resumable (§6.6). The node stops being
      // flagged so it is not mistaken for something needing attention, but
      // nothing is thrown away and resume stays available.
      store.setNodeStatus(row.id, row.head_commit === null ? 'new' : 'ready');
      bus.publish(row.project_id, { type: 'tree.updated', projectId: row.project_id });
      sendJson(res, 200, { ok: true });
      return;

    default:
      throw new HttpError(400, 'action must be resume, discard or keep');
  }
});

/** The diff a single run produced, so the conversation can show it in place. */
route('GET', '/api/runs/:id/diff', async (_req, res, params, { store }) => {
  const run = store.getRun(params['id']!);
  if (run === undefined) throw new HttpError(404, 'no such run');
  if (run.commit_sha === null) throw new HttpError(400, 'this run changed nothing');
  const node = store.getNode(run.node_id);
  if (node === undefined) throw new HttpError(404, 'no such node');

  const base = await parentSnapshot(node.worktree_path, run.commit_sha);
  sendJson(res, 200, await runDiff(node.worktree_path, base, run.commit_sha));
});

// -- events ------------------------------------------------------------------

route('GET', '/api/events', (req, res, _p, { bus }) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const projectId = url.searchParams.get('projectId');
  if (projectId === null) throw new HttpError(400, 'projectId is required');
  bus.subscribe(projectId, res);
});

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return false;

  try {
    assertLocalRequest(req.headers);
  } catch (error) {
    sendError(res, error);
    return true;
  }
  const found = match(req.method ?? 'GET', url.pathname);
  if (found === null) {
    ctx.log.warn('api.unrouted', { method: req.method, path: url.pathname });
    sendError(res, new HttpError(404, `no route for ${req.method} ${url.pathname}`));
    return true;
  }
  try {
    await found.handler(req, res, found.params, ctx);
  } catch (err) {
    /**
     * Logged here rather than in sendError, which has the error but not the
     * request -- and "something 500'd" without a method and a path is the
     * least useful line a log can hold.
     *
     * The path is logged as the ROUTE PATTERN, not the request path, so ids
     * do not accumulate as unique strings and the message is greppable.
     */
    const status =
      err instanceof HttpError ? err.status : err instanceof OperationConflict ? 409 : 500;
    const message = err instanceof Error ? err.message : String(err);
    ctx.log[status >= 500 ? 'error' : 'warn']('api.error', {
      method: req.method,
      route: found.pattern,
      status,
      error: message,
    });
    sendError(res, err);
  }
  return true;
}
