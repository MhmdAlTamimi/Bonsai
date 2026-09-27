import { randomUUID } from 'node:crypto';
import type { NodeStatus } from '@bonsai/shared';

import type {
  ChoiceDecision,
  ChoiceRequest,
  PermissionDecision,
  PermissionRequest,
} from '../agent/AgentRunner.js';
import type { EventBus } from '../api/events.js';
import type { NodeRow, Store } from '../db/store.js';
import type { Logger } from '../log.js';

/**
 * Questions a run stops on: a permission the agent needs (D34), or something
 * it asked the user (D42). A parked run waits here until it is answered, left
 * to the agent, or stopped.
 */

/** What a parked run is told when the node is stopped rather than answered. */
const STOPPED: PermissionDecision = { allow: false, reason: 'the run was stopped' };

/**
 * The question, as the panel and the card will show it.
 *
 * A statement rather than a question mark: the card already carries a `?`
 * glyph and the words "needs you", so "May the agent...?" would be the third
 * time the same screen asked.
 */
function questionText(request: PermissionRequest): string {
  const detail = request.detail.trim();
  return detail === ''
    ? `The agent wants to use ${request.toolName}.`
    : `The agent wants to use ${request.toolName}: ${detail}`;
}

/** A run held on a question, and the one function that lets it go. */
interface Waiter {
  questionId: string;
  /** Which kind of answer releases it, so the wrong kind cannot. */
  kind: 'permission' | 'choice';
  settle: (outcome: PermissionDecision | ChoiceDecision, resume: boolean) => void;
}

/** What a parked question is told when the node is stopped rather than answered. */
const STOPPED_CHOICE: ChoiceDecision = { answered: false, reason: 'the run was stopped' };

/**
 * Told to the agent when the user leaves a question to it (D42).
 *
 * It has to say what to do, not only that nobody answered: the SDK hands this
 * back as the tool's result, and "decide, and say what you assumed" is the
 * difference between an agent that carries on visibly and one that guesses in
 * silence -- or, as before, one that announces it is waiting and stops.
 */
export const LEFT_TO_AGENT =
  'The user chose not to answer and left this decision to you. Make a reasonable choice, ' +
  'carry on, and say clearly in your reply what you decided and why.';

/** The question as the card and the transcript show it: the questions, in order. */
function choiceText(request: ChoiceRequest): string {
  return request.questions.map((q) => q.question).join(' · ');
}

export class QuestionDesk {
  /**
   * Runs parked on a question, by node id. One at a time per node: a node has
   * at most one run, and a run stops dead until its question is answered.
   *
   * A parked run still holds its concurrency slot, because it still holds an
   * agent process and a live session -- there is nothing to release. That is
   * visible (the card says `needs you`) and escapable (stopping the node
   * resolves the question as a refusal and frees the slot), which is the
   * honest version of a problem the alternatives only hide.
   */
  private readonly waiting = new Map<string, Waiter>();

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly log: Logger,
    private readonly setStatus: (nodeId: string, status: NodeStatus) => void,
  ) {}

  /** Whether a run of this node is parked on a question. */
  isWaiting(nodeId: string): boolean {
    return this.waiting.has(nodeId);
  }

  release(
    questionId: string,
    kind: Waiter['kind'],
    outcome: PermissionDecision | ChoiceDecision,
  ): boolean {
    const question = this.store.getQuestion(questionId);
    if (question === undefined) return false;
    const waiter = this.waiting.get(question.node_id);
    if (waiter?.questionId !== questionId || waiter.kind !== kind) return false;
    waiter.settle(outcome, true);
    return true;
  }

  /** The question a node is parked on, if it is. */
  pendingAsk(nodeId: string): string | null {
    return this.waiting.get(nodeId)?.questionId ?? null;
  }

  /**
   * Stops the run and asks permission (D34). Resolves when the user answers,
   * or when the node is stopped.
   */
  askUser(
    node: NodeRow,
    runId: string,
    request: PermissionRequest,
    controller: AbortController,
  ): Promise<PermissionDecision> {
    const text = questionText(request);
    return this.park<PermissionDecision>(node, runId, controller, {
      kind: 'permission',
      text,
      record: {
        request: {
          action: request.toolName,
          target: request.detail,
          details: request.details ?? request.detail,
        },
      },
      transcript: request.details ? `${text}\n\n${request.details}` : text,
      logged: { tool: request.toolName },
      stopped: STOPPED,
      said: (decision) => (decision.allow ? 'Allowed.' : `Refused: ${decision.reason}`),
    });
  }

  /**
   * Stops the run and puts the agent's own question to the user (D42).
   * Resolves with the answers, with "left to the agent", or when stopped.
   */
  askChoices(
    node: NodeRow,
    runId: string,
    request: ChoiceRequest,
    controller: AbortController,
  ): Promise<ChoiceDecision> {
    return this.park<ChoiceDecision>(node, runId, controller, {
      kind: 'choice',
      text: choiceText(request),
      record: { questions: request.questions },
      /**
       * The options go into the transcript as well as the question, because
       * "what was it choosing between?" matters as much as what was chosen,
       * and the question row alone is not what anyone reads a week later.
       */
      transcript: request.questions
        .map(
          (q) =>
            `The agent asked: ${q.question}\nOptions: ${q.options.map((o) => o.label).join(' · ')}` +
            (q.multiSelect ? ' (any that apply)' : ''),
        )
        .join('\n\n'),
      logged: { questions: request.questions.length },
      stopped: STOPPED_CHOICE,
      said: (decision) =>
        decision.answered
          ? request.questions
              .map((q) => `${q.question} → ${decision.answers[q.question] ?? ''}`)
              .join('\n')
          : decision.reason === LEFT_TO_AGENT
            ? 'Left the decision to the agent.'
            : `Not answered: ${decision.reason}`,
    });
  }

  /**
   * Parks a run on a question until it is answered or the node is stopped.
   *
   * One implementation for both kinds, because everything that makes parking
   * safe is the same for both, and a second copy is where one of them would
   * lose it:
   *
   *   the question row is written BEFORE the status changes, so no card ever
   *   reads `needs you` with nothing to show;
   *
   *   an answer and an abort can race, and only the first settles it;
   *
   *   stopping the node settles it, or the run hangs on a promise nobody will
   *   resolve and its concurrency slot never comes back;
   *
   *   the status goes back to running BEFORE the promise resolves, so a card
   *   never says `needs you` for a run that is already going again.
   *
   * Both the question and the answer land in the transcript, because "why did
   * this run stall for ten minutes, and what did it decide" should be
   * answerable a week later from the conversation alone.
   */
  private park<T extends PermissionDecision | ChoiceDecision>(
    node: NodeRow,
    runId: string,
    controller: AbortController,
    question: {
      kind: Waiter['kind'];
      text: string;
      record: Pick<Parameters<Store['askQuestion']>[0], 'request' | 'questions'>;
      transcript: string;
      logged: Record<string, unknown>;
      stopped: T;
      said: (outcome: T) => string;
    },
  ): Promise<T> {
    if (controller.signal.aborted) return Promise.resolve(question.stopped);

    const questionId = randomUUID();
    this.store.askQuestion({
      id: questionId,
      runId,
      nodeId: node.id,
      text: question.text,
      ...question.record,
    });
    this.store.appendMessage({
      nodeId: node.id,
      runId,
      role: 'system',
      kind: 'text',
      content: question.transcript,
    });
    this.log.info('run.asked', {
      runId,
      nodeId: node.id,
      projectId: node.project_id,
      kind: question.kind,
      ...question.logged,
    });
    this.setStatus(node.id, 'needs_you');
    this.bus.publish(node.project_id, {
      type: 'run.question',
      nodeId: node.id,
      runId,
      questionId,
      text: question.text,
    });
    this.bus.publish(node.project_id, { type: 'tree.updated', projectId: node.project_id });

    return new Promise<T>((resolve) => {
      let settled = false;
      const settle = (outcome: T, resume: boolean): void => {
        if (settled) return;
        settled = true;
        this.waiting.delete(node.id);
        controller.signal.removeEventListener('abort', onAbort);

        const said = question.said(outcome);
        this.store.answerQuestion(questionId, said);
        this.store.appendMessage({
          nodeId: node.id,
          runId,
          role: 'user',
          kind: 'text',
          content: said,
        });
        if (resume) {
          this.setStatus(node.id, 'running');
          this.bus.publish(node.project_id, { type: 'tree.updated', projectId: node.project_id });
        }
        resolve(outcome);
      };

      const onAbort = (): void => settle(question.stopped, false);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      // The waiter's kind decides which answer may release it, so the release
      // paths hand over the matching outcome type.
      this.waiting.set(node.id, {
        questionId,
        kind: question.kind,
        settle: settle as Waiter['settle'],
      });
    });
  }
}
