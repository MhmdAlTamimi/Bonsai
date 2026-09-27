import { parseAnswer } from '../answers.js';
import type {
  AnswerQuestionRequest,
  CompactRequest,
  RecoverRequest,
  StartRunRequest,
} from '@bonsai/shared';
import { isUsersOwnCheckout } from '../../db/store.js';
import { attachedReferences, referredExperiments } from '../references.js';
import { assertGitState, expectedGitState } from '../../git/ownership.js';
import { runDiff, parentSnapshot } from '../../git/diff.js';
import { discardWorktreeChanges } from '../../git/recovery.js';
import { HttpError, readJson, requireString, sendJson } from '../http.js';
import { route, requireConnection } from '../routing.js';

/** Runs: starting, stopping, answering questions, and recovering from ones that did not finish. */

route('POST', '/api/nodes/:id/runs', async (req, res, params, { store, jobs, connection }) => {
  requireConnection(connection);
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const body = await readJson<StartRunRequest>(req);
  const referenceIds = attachedReferences(store, row.project_id, body.referenceIds);
  const experimentIds = referredExperiments(store, row, body.experimentIds);
  try {
    sendJson(
      res,
      202,
      jobs.start(row.id, requireString(body.prompt, 'prompt'), { referenceIds, experimentIds }),
    );
  } catch (err) {
    throw new HttpError(409, err instanceof Error ? err.message : String(err));
  }
});

/**
 * Compacts a node's conversation now, the way `/compact` does in Claude Code:
 * older turns become a summary, freeing context. Asynchronous like any run.
 * `focus` is collapsed to one line, because it rides on the command itself.
 */
route('POST', '/api/nodes/:id/compact', async (req, res, params, { store, jobs, connection }) => {
  requireConnection(connection);
  const row = store.getNode(params['id']!);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const body = await readJson<CompactRequest>(req);
  const focus = typeof body.focus === 'string' ? body.focus.replace(/\s+/g, ' ').trim() : '';
  if (focus.length > 500) throw new HttpError(400, 'Keep the focus under 500 characters.');
  sendJson(res, 202, jobs.compact(row.id, focus === '' ? null : focus));
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
      await assertGitState(
        row.worktree_path,
        await expectedGitState(store.getProject(row.project_id)!.repo_path, row),
      );
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
