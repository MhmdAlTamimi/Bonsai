import type { AnswerQuestionRequest } from '@bonsai/shared';

import type { StoredQuestion } from '../db/store.js';
import type { PermissionDecision } from '../agent/AgentRunner.js';
import { HttpError } from './http.js';

/**
 * What an answer to a parked question means, checked against the question.
 *
 * Checked against the STORED question rather than trusted from the request,
 * because the two kinds take different answers and a mismatch is a real bug to
 * surface: "allow" sent to a question the agent asked, or answers sent to a
 * permission prompt, must not be quietly turned into something else.
 *
 * Pure, so the rules are testable without an HTTP server.
 */
export type ParsedAnswer =
  | { kind: 'permission'; decision: PermissionDecision }
  | { kind: 'choice'; answers: Record<string, string> }
  | { kind: 'leftToAgent' };

/** Long enough for a paragraph of instruction; short enough to be an answer. */
const MAX_ANSWER = 4000;

export function parseAnswer(question: StoredQuestion, body: AnswerQuestionRequest): ParsedAnswer {
  if (question.kind === 'permission') {
    if (body.answers !== undefined || body.agentDecides !== undefined)
      throw new HttpError(400, 'This question asks for permission. Allow it or refuse it.');
    if (typeof body.allow !== 'boolean') throw new HttpError(400, 'allow must be true or false');
    const said = (body.message ?? '').trim();
    return {
      kind: 'permission',
      decision: body.allow ? { allow: true } : { allow: false, reason: said === '' ? 'No.' : said },
    };
  }

  if (body.allow !== undefined)
    throw new HttpError(400, 'The agent asked a question. Answer it, or leave it to the agent.');

  if (body.agentDecides === true) {
    if (body.answers !== undefined)
      throw new HttpError(400, 'Either answer the question or leave it to the agent, not both.');
    return { kind: 'leftToAgent' };
  }

  const answers = body.answers;
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers))
    throw new HttpError(400, 'Answer every question, or leave the decision to the agent.');

  const asked = (question.questions ?? []).map((q) => q.question);
  const unknown = Object.keys(answers).filter((key) => !asked.includes(key));
  if (unknown.length > 0)
    throw new HttpError(400, 'Those answers are for a different question. Refresh and try again.');

  const out: Record<string, string> = {};
  for (const text of asked) {
    const value: unknown = answers[text];
    if (typeof value !== 'string' || value.trim() === '')
      throw new HttpError(400, `Answer every question before sending. Missing: ${text}`);
    if (value.length > MAX_ANSWER)
      throw new HttpError(400, 'That answer is too long. Keep it to a few paragraphs.');
    out[text] = value.trim();
  }
  return { kind: 'choice', answers: out };
}
