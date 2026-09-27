import type { AskComparisonRequest, CreateComparisonRequest } from '@bonsai/shared';
import { attachedReferences, comparedExperiments } from '../references.js';
import { HttpError, readJson, requireString, sendJson } from '../http.js';
import { route, requireConnection } from '../routing.js';

/** Comparisons of 2-4 experiments, answered by an agent that only reads. */

/** The project's comparisons, most recently used first. */
route('GET', '/api/projects/:id/comparisons', (_req, res, params, { store, comparisons }) => {
  if (store.getProject(params['id']!) === undefined) throw new HttpError(404, 'no such project');
  sendJson(
    res,
    200,
    store.comparisonSummaries(params['id']!, (id) => comparisons.isRunning(id)),
  );
});

/**
 * A comparison of 2-4 experiments. Their snapshots are taken now; nothing is
 * asked until the user asks.
 */
route('POST', '/api/projects/:id/comparisons', async (req, res, params, ctx) => {
  const projectId = params['id']!;
  if (ctx.store.getProject(projectId) === undefined) throw new HttpError(404, 'no such project');
  const body = await readJson<CreateComparisonRequest>(req);
  const nodes = comparedExperiments(ctx.store, projectId, body.nodeIds);
  const row = await ctx.comparisons.create(projectId, nodes);
  sendJson(res, 201, ctx.store.comparisonView(row));
});

route('GET', '/api/comparisons/:id', (_req, res, params, { store }) => {
  const row = store.comparisons.get(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such comparison');
  sendJson(res, 200, store.comparisonView(row));
});

route('POST', '/api/comparisons/:id/messages', async (req, res, params, ctx) => {
  requireConnection(ctx.connection);
  const body = await readJson<AskComparisonRequest>(req);
  const prompt = requireString(body.prompt, 'prompt').trim();
  if (prompt === '') throw new HttpError(400, 'Ask something about these experiments.');
  const row = ctx.store.comparisons.get(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such comparison');
  const referenceIds = attachedReferences(ctx.store, row.project_id, body.referenceIds);
  sendJson(res, 202, ctx.comparisons.ask(row.id, prompt, referenceIds));
});

route('POST', '/api/comparisons/:id/stop', (_req, res, params, { comparisons }) => {
  comparisons.stop(params['id']!);
  sendJson(res, 200, { ok: true });
});

/** Fresh snapshots of every experiment that has moved on since. */
route('POST', '/api/comparisons/:id/refresh', async (_req, res, params, { store, comparisons }) => {
  const updated = await comparisons.refresh(params['id']!);
  sendJson(res, 200, {
    updated,
    comparison: store.comparisonView(store.comparisons.get(params['id']!)!),
  });
});

route('PATCH', '/api/comparisons/:id', async (req, res, params, { store, bus }) => {
  const row = store.comparisons.get(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such comparison');
  const body = await readJson<{ title?: unknown }>(req);
  const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : '';
  if (title === '' || title.length > 120) {
    throw new HttpError(400, 'Give the comparison a name of up to 120 characters.');
  }
  store.comparisons.rename(row.id, title);
  bus.publish(row.project_id, {
    type: 'comparison.updated',
    projectId: row.project_id,
    comparisonId: row.id,
  });
  sendJson(res, 200, store.comparisonView(store.comparisons.get(row.id)!));
});

route('DELETE', '/api/comparisons/:id', async (_req, res, params, { comparisons }) => {
  await comparisons.delete(params['id']!);
  sendJson(res, 200, { ok: true });
});
