import { ProjectOperations } from './projectOperations.js';
import { OperationConflict } from '../domain/errors.js';
import { assertLocalRequest } from './localRequest.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NodeView } from '@bonsai/shared';
import { type Store } from '../db/store.js';
import type { EventBus } from './events.js';
import type { RunJobs } from '../jobs/runNode.js';
import type { ConversationCopier, TextDrafter } from '../agent/AgentRunner.js';
import type { ComparisonJobs } from '../jobs/comparisons.js';
import type { Settings } from '../settings.js';
import { Connection } from './connectionGate.js';
import { HttpError, sendError } from './http.js';
import { type Logger } from '../log.js';

/**
 * The API's route table: how a request finds its handler, and what every
 * handler is given. The routes themselves live in ./routes/, one file per
 * area, and register themselves here when ./router.ts imports them.
 */
export interface Ctx {
  store: Store;
  bus: EventBus;
  jobs: RunJobs;
  /** Copies a parent's conversation into a child when it is created. */
  conversations: ConversationCopier;
  /** Drafts a reference from a conversation: one model turn, no tools. */
  drafts: TextDrafter;
  /** Comparisons of 2-4 experiments, answered by an agent that only reads. */
  comparisons: ComparisonJobs;
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
export function withLive(jobs: RunJobs, nodes: NodeView[]): NodeView[] {
  return nodes.map((n) => ({
    ...n,
    queuePosition: jobs.queuePosition(n.id),
    activeRunId: jobs.activeRunId(n.id),
    activity: jobs.activity(n.id),
  }));
}

export function requireConnection(connection: Connection): void {
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

export function route(method: string, pattern: string, handler: Handler): void {
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

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return false;

  try {
    assertLocalRequest(req.headers, req.method);
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
