import { useEffect, useState } from 'react';
import type {
  ComparisonSummary,
  ComparisonTurnView,
  ComparisonView,
  MessageView,
  RunView,
} from '@bonsai/shared';

import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';

/** Enough to weigh a few approaches side by side, and few enough to read that way. */
export const COMPARE_MIN = 2;
export const COMPARE_MAX = 4;

/**
 * An experiment's colour in a comparison, by its position: the same on the
 * map while picking, on its card, and wherever the comparison names it.
 */
export const compareTone = (position: number): string => `cmp-${(position % COMPARE_MAX) + 1}`;

/**
 * A comparison's conversation, shaped like an experiment's, so the one
 * conversation view draws both: each question-and-answer is a "run". A note
 * between questions (an update) stands on its own, in its place, rather than
 * being filed with an experiment's setup, which is what a run-less message
 * means there.
 */
export function comparisonMessages(view: ComparisonView): MessageView[] {
  return view.messages.map((message) => ({
    id: message.id,
    nodeId: view.id,
    runId: message.turnId ?? `note:${message.id}`,
    seq: message.seq,
    role: message.role,
    kind: message.kind,
    content: message.content,
    createdAt: message.createdAt,
  }));
}

export function comparisonRuns(view: ComparisonView): RunView[] {
  return view.turns.map((turn) => turnAsRun(view.id, turn));
}

function turnAsRun(comparisonId: string, turn: ComparisonTurnView): RunView {
  const ended = turn.endedAt === null ? null : Date.parse(turn.endedAt);
  return {
    id: turn.id,
    nodeId: comparisonId,
    status: turn.status,
    endReason:
      turn.status === 'running'
        ? null
        : turn.status === 'cancelled'
          ? 'stopped'
          : turn.status === 'failed'
            ? 'failed'
            : 'finished',
    stoppedBackground: 0,
    change: null,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: turn.costUsd,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: turn.model,
    apiKeySource: null,
    commitSha: null,
    toolsOffered: null,
    toolCalls: 0,
    durationMs: ended === null ? null : ended - Date.parse(turn.startedAt),
    error: turn.error,
    // Only what the conversation draws: the references the question went with.
    ...(turn.references.length === 0
      ? {}
      : {
          resolvedContext: {
            resolvedAt: turn.startedAt,
            successCriteria: null,
            verificationHint: null,
            codeCommit: null,
            parentNodeId: null,
            parentName: null,
            parentHeadCommit: null,
            references: turn.references,
          },
        }),
  };
}

/** A comparison, fetched again whenever the server says it changed. */
export function useComparison(
  comparisonId: string,
  revision: string,
): { data: ComparisonView | null; error: string | null } {
  const [data, setData] = useState<ComparisonView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api
      .comparison(comparisonId, controller.signal)
      .then((view) => {
        setData(view);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(describeError(e));
      });
    return () => controller.abort();
  }, [comparisonId, revision]);
  // A different comparison is a different page, not an update of this one.
  return { data: data?.id === comparisonId ? data : null, error };
}

/** The open project's comparisons, most recently used first. */
export function useComparisons(
  projectId: string | null,
  revision: number,
): readonly ComparisonSummary[] {
  const [loaded, setLoaded] = useState<{ projectId: string; list: ComparisonSummary[] } | null>(
    null,
  );
  useEffect(() => {
    if (projectId === null) return;
    let alive = true;
    api
      .comparisons(projectId)
      .then((list) => {
        if (alive) setLoaded({ projectId, list });
      })
      // The list is a convenience; the map and comparisons themselves still work.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [projectId, revision]);
  return loaded !== null && loaded.projectId === projectId ? loaded.list : NONE;
}

const NONE: readonly ComparisonSummary[] = [];
