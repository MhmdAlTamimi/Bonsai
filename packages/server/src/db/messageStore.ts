import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AgentQuestion, MessageView, NodeView } from '@bonsai/shared';

import { now } from './rows.js';

/**
 * The conversation: messages, and the questions a run stops on.
 *
 * Questions belong here rather than with runs because they are part of what the
 * panel reads as the conversation -- the agent stops, asks, and the answer is
 * appended to the transcript like any other turn.
 */
export class MessageStore {
  constructor(private readonly db: DatabaseSync) {}

  list(nodeId: string, afterSeq: number): MessageView[] {
    const rows = this.db
      .prepare(`SELECT * FROM message WHERE node_id = ? AND seq > ? ORDER BY seq ASC`)
      .all(nodeId, afterSeq) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r['id'] as string,
      nodeId: r['node_id'] as string,
      runId: (r['run_id'] as string | null) ?? null,
      seq: Number(r['seq']),
      role: r['role'] as MessageView['role'],
      kind: r['kind'] as MessageView['kind'],
      content: JSON.parse(r['content_json'] as string) as unknown,
      createdAt: r['created_at'] as string,
    }));
  }

  append(input: {
    nodeId: string;
    runId: string | null;
    role: MessageView['role'];
    kind: MessageView['kind'];
    content: unknown;
  }): MessageView {
    const next = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM message WHERE node_id = ?`)
      .get(input.nodeId) as unknown as { seq: number };
    const view: MessageView = {
      id: randomUUID(),
      nodeId: input.nodeId,
      runId: input.runId,
      seq: Number(next.seq),
      role: input.role,
      kind: input.kind,
      content: input.content,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO message (id, node_id, run_id, seq, role, kind, content_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        view.id,
        view.nodeId,
        view.runId,
        view.seq,
        view.role,
        view.kind,
        JSON.stringify(view.content),
        view.createdAt,
      );
    return view;
  }

  count(nodeId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM message WHERE node_id = ?`)
      .get(nodeId) as unknown as { seq: number };
    return Number(row.seq);
  }

  /**
   * First user message of the latest attributed run, excluding later answers.
   * Legacy messages without a run cannot be distinguished safely: return null
   * so recovery uses the node description instead of an arbitrary reply.
   */
  lastUserPrompt(nodeId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT content_json FROM message
         WHERE node_id = ? AND role = 'user' AND kind = 'text'
           AND run_id IS NOT NULL
           AND seq = (SELECT MIN(first.seq) FROM message first
             WHERE first.node_id = message.node_id AND first.run_id = message.run_id
               AND first.role = 'user')
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(nodeId) as unknown as { content_json: string } | undefined;
    if (row === undefined) return null;
    try {
      const parsed: unknown = JSON.parse(row.content_json);
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * D34: the agent has stopped and wants an answer.
   *
   * Written before the node's status changes, so there is never a moment where
   * a card says `needs_you` and the panel has no question to show.
   */
  askQuestion(input: {
    id: string;
    runId: string;
    nodeId: string;
    text: string;
    /** A permission question: the action the agent wants to take. */
    request?: NonNullable<NodeView['pendingQuestion']>['request'];
    /** A question the agent asked (D42): what it asked, and the options it offered. */
    questions?: AgentQuestion[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO question (id, run_id, node_id, text, asked_at, request_json) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.runId, input.nodeId, input.text, now(), requestJson(input));
  }

  /**
   * Records the answer and reports whether this call is the one that landed it.
   *
   * False means it was already answered. The interface can be open in two
   * windows, and the second click must not resume a run twice -- so the check
   * and the write are one statement rather than a read followed by a write.
   */
  answerQuestion(questionId: string, answer: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE question SET answer = ?, answered_at = ? WHERE id = ? AND answered_at IS NULL`,
      )
      .run(answer, now(), questionId);
    return result.changes > 0;
  }

  getQuestion(questionId: string): StoredQuestion | undefined {
    const row = this.db
      .prepare(
        `SELECT id, node_id, run_id, text, answered_at, request_json FROM question WHERE id = ?`,
      )
      .get(questionId) as unknown as
      | {
          id: string;
          node_id: string;
          run_id: string;
          text: string;
          answered_at: string | null;
          request_json: string | null;
        }
      | undefined;
    if (row === undefined) return undefined;
    const { request_json, ...rest } = row;
    return { ...rest, ...readRequest(request_json) };
  }

  pendingQuestion(nodeId: string): NodeView['pendingQuestion'] {
    const row = this.db
      .prepare(
        `SELECT id, text, request_json FROM question
         WHERE node_id = ? AND answered_at IS NULL
         ORDER BY asked_at DESC LIMIT 1`,
      )
      .get(nodeId) as unknown as
      { id: string; text: string; request_json: string | null } | undefined;
    if (!row) return null;
    return { id: row.id, text: row.text, ...readRequest(row.request_json) };
  }
}

/** A question row, with what kind of answer it is waiting for. */
export interface StoredQuestion {
  id: string;
  node_id: string;
  run_id: string;
  text: string;
  answered_at: string | null;
  kind: 'permission' | 'choice';
  request?: NonNullable<NodeView['pendingQuestion']>['request'];
  questions?: AgentQuestion[];
}

/**
 * What goes in `request_json`.
 *
 * No migration: a choice question carries `kind: 'choice'` inside the JSON,
 * and a permission question keeps exactly the shape it always had -- so every
 * row written before questions existed still reads as what it was.
 */
function requestJson(input: {
  request?: NonNullable<NodeView['pendingQuestion']>['request'];
  questions?: AgentQuestion[];
}): string | null {
  if (input.questions !== undefined)
    return JSON.stringify({ kind: 'choice', questions: input.questions });
  return input.request ? JSON.stringify(input.request) : null;
}

function readRequest(json: string | null): {
  kind: 'permission' | 'choice';
  request?: NonNullable<NodeView['pendingQuestion']>['request'];
  questions?: AgentQuestion[];
} {
  if (json === null) return { kind: 'permission' };
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (parsed['kind'] === 'choice' && Array.isArray(parsed['questions']))
    return { kind: 'choice', questions: parsed['questions'] as AgentQuestion[] };
  return {
    kind: 'permission',
    request: parsed as unknown as NonNullable<NodeView['pendingQuestion']>['request'],
  };
}
