import type {
  CreateReferenceRequest,
  DraftReferenceRequest,
  DraftReferenceResponse,
  UpdateReferenceRequest,
} from '@bonsai/shared';
import type { MessageView } from '@bonsai/shared';
import { type Store } from '../../db/store.js';
import {
  DRAFT_INSTRUCTIONS,
  draftInput,
  draftInstruction,
  referenceContent,
  referenceName,
  referenceSource,
} from '../references.js';
import { conversationText } from '../../domain/conversationText.js';
import { readRunReference } from '../../jobs/runContext.js';
import { readComparisonReference } from '../../jobs/comparisons.js';
import { experimentNotes } from '../review.js';
import { HttpError, readJson, sendJson } from '../http.js';
import { route, requireConnection } from '../routing.js';

/** References: the project's shared text, and drafting one from a conversation. */

/**
 * The exact text a run was given for one of its references -- the version it
 * saw, not the reference as it reads now.
 */
route('GET', '/api/runs/:id/references/:referenceId', async (_req, res, params, { store }) => {
  // A comparison's question is shown as a run, and its chips open the same way.
  const turn = store.comparisons.turn(params['id']!);
  if (turn !== undefined) {
    const recorded = turn.references.find((r) => r.id === params['referenceId']);
    if (recorded === undefined)
      throw new HttpError(404, 'That question was not asked with this reference.');
    const content = await readComparisonReference(
      store,
      turn.comparisonId,
      params['id']!,
      recorded,
    ).catch(() => {
      throw new HttpError(410, 'The copy this question was given is no longer on disk.');
    });
    sendJson(res, 200, { ...recorded, content });
    return;
  }
  const run = store.getRun(params['id']!);
  const node = run === undefined ? undefined : store.getNode(run.node_id);
  if (run === undefined || node === undefined) throw new HttpError(404, 'no such run');
  const recorded = store
    .listRuns(node.id)
    .find((r) => r.id === run.id)
    ?.resolvedContext?.references?.find((r) => r.id === params['referenceId']);
  if (recorded === undefined) throw new HttpError(404, 'That run was not given this reference.');
  const content = await readRunReference(store, node.project_id, run.id, recorded).catch(() => {
    throw new HttpError(410, 'The copy this run was given is no longer on disk.');
  });
  sendJson(res, 200, { ...recorded, content });
});

/**
 * A draft of a reference, written from an experiment's own conversation and
 * notes. Nothing is saved: the text goes back to the editor, where the user
 * reads it, changes it and decides. The conversation the experiment copied
 * from its parent is not included -- it belongs to the parent, and can be
 * drafted from there.
 *
 * The model call is abandoned if the browser goes away, so closing the editor
 * does not leave a draft being paid for in the background.
 */
route('POST', '/api/references/draft', async (req, res, _params, ctx) => {
  const { store, settings, connection, log } = ctx;
  requireConnection(connection);
  const body = await readJson<DraftReferenceRequest>(req);
  const source = await draftSource(store, body);
  const project = store.getProject(source.projectId);
  if (project === undefined) throw new HttpError(404, 'no such project');
  const instruction = draftInstruction(body.instruction);
  const current =
    typeof body.current === 'string' && body.current.trim() !== '' ? body.current : null;
  if (source.messages.length === 0 && source.notes === null) {
    throw new HttpError(400, source.empty);
  }
  const conversation = conversationText(source.messages, source.notes);

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const startedAt = Date.now();
  const text = await ctx.drafts.draft({
    instructions: DRAFT_INSTRUCTIONS,
    input: draftInput(conversation.text, instruction, current),
    model: source.model ?? project.default_model ?? settings.model(),
    agentEnv: settings.agentEnv(),
    signal: controller.signal,
  });
  // Sizes, never contents: the conversation is the user's own words.
  log.info('reference.draft', {
    from: source.kind,
    inputChars: conversation.text.length,
    outputChars: text.length,
    durationMs: Date.now() - startedAt,
    ...conversation.basis,
  });
  if (controller.signal.aborted) return;
  if (text === '') throw new HttpError(502, 'The draft came back empty. Try asking differently.');
  sendJson(res, 200, { text, basis: conversation.basis } satisfies DraftReferenceResponse);
});

/**
 * What a draft reads: an experiment's own conversation and committed notes, or
 * a comparison's conversation. The conversation an experiment copied from its
 * parent is not included -- it belongs to the parent, and can be drafted from
 * there.
 */
async function draftSource(
  store: Store,
  body: DraftReferenceRequest,
): Promise<{
  kind: 'experiment' | 'comparison';
  projectId: string;
  messages: MessageView[];
  notes: string | null;
  model: string | null;
  empty: string;
}> {
  if (typeof body.comparisonId === 'string') {
    const row = store.comparisons.get(body.comparisonId);
    if (row === undefined) throw new HttpError(404, 'no such comparison');
    return {
      kind: 'comparison',
      projectId: row.project_id,
      messages: store.comparisons.messages(row.id).map((m) => ({
        ...m,
        nodeId: row.id,
        runId: m.turnId,
      })),
      notes: null,
      model: null,
      empty: 'This comparison has no conversation to draw from yet.',
    };
  }
  const node = typeof body.nodeId === 'string' ? store.getNode(body.nodeId) : undefined;
  if (node === undefined) throw new HttpError(404, 'no such experiment');
  return {
    kind: 'experiment',
    projectId: node.project_id,
    messages: store.listMessages(node.id, 0),
    notes:
      node.worktree_allocated === 0 && node.archived_at === null
        ? null
        : (await experimentNotes(store, node)).contextMd,
    model: node.model,
    empty: 'This experiment has no conversation to draw from yet.',
  };
}

/** Every reference in a project, by name. */
route('GET', '/api/projects/:id/references', (_req, res, params, { store }) => {
  if (store.getProject(params['id']!) === undefined) throw new HttpError(404, 'no such project');
  sendJson(
    res,
    200,
    store.references.list(params['id']!).map((row) => store.referenceView(row)),
  );
});

route('POST', '/api/projects/:id/references', async (req, res, params, { store, bus }) => {
  const projectId = params['id']!;
  if (store.getProject(projectId) === undefined) throw new HttpError(404, 'no such project');
  const body = await readJson<CreateReferenceRequest>(req);
  const comparisonId = typeof body.sourceComparisonId === 'string' ? body.sourceComparisonId : null;
  if (comparisonId !== null && store.comparisons.get(comparisonId)?.project_id !== projectId) {
    throw new HttpError(400, 'That comparison is not in this project.');
  }
  const row = store.references.create({
    projectId,
    name: referenceName(body.name),
    content: referenceContent(body.content),
    sourceNodeId: referenceSource(store, projectId, body.sourceNodeId) ?? null,
    sourceComparisonId: comparisonId,
  });
  bus.publish(projectId, { type: 'references.updated', projectId });
  sendJson(res, 201, store.referenceView(row));
});

/**
 * Edits apply to runs from now on. A run that already used the reference keeps
 * the snapshot it was given, which is what makes this safe to allow at all.
 */
route('PATCH', '/api/references/:id', async (req, res, params, { store, bus }) => {
  const row = store.references.get(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such reference');
  const body = await readJson<UpdateReferenceRequest>(req);
  const sourceNodeId = referenceSource(store, row.project_id, body.sourceNodeId);
  store.references.update(row.id, {
    ...(body.name === undefined ? {} : { name: referenceName(body.name) }),
    ...(body.content === undefined ? {} : { content: referenceContent(body.content) }),
    ...(sourceNodeId === undefined ? {} : { sourceNodeId }),
  });
  bus.publish(row.project_id, { type: 'references.updated', projectId: row.project_id });
  sendJson(res, 200, store.referenceView(store.references.get(row.id)!));
});

route('DELETE', '/api/references/:id', (_req, res, params, { store, bus }) => {
  const row = store.references.get(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such reference');
  store.references.delete(row.id);
  bus.publish(row.project_id, { type: 'references.updated', projectId: row.project_id });
  sendJson(res, 200, { ok: true });
});
