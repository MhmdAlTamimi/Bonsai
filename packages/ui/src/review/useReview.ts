import { useEffect, useState } from 'react';
import type { ReviewFilePatchView, ReviewView } from '@bonsai/shared';

import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';

/**
 * What review reads, fetched where it is shown.
 *
 * The list of files comes once per experiment; a file's patch comes when a
 * file is opened, and is kept so moving back to a file already read is
 * instant. Both refetch when the experiment changes -- a run that commits is
 * a change to what there is to review.
 */
export function useReview(
  nodeId: string | null,
  revision: string,
): { data: ReviewView | null; error: string | null; retry: () => void } {
  const [data, setData] = useState<{ key: string; value: ReviewView } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${nodeId ?? ''}:${revision}`;

  useEffect(() => {
    if (nodeId === null) return;
    let alive = true;
    const controller = new AbortController();
    setError(null);
    api
      .review(nodeId, controller.signal)
      .then((value) => alive && setData({ key, value }))
      .catch((e: unknown) => {
        if (alive && !controller.signal.aborted) setError(describeError(e));
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [nodeId, key, attempt]);

  return {
    data: data?.value ?? null,
    error,
    retry: () => setAttempt((n) => n + 1),
  };
}

export function useFilePatch(
  nodeId: string | null,
  path: string | null,
  revision: string,
): { data: ReviewFilePatchView | null; error: string | null; loading: boolean } {
  const [cache, setCache] = useState<Map<string, ReviewFilePatchView>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const key = `${nodeId ?? ''}:${revision}:${path ?? ''}`;

  // A run that changes the experiment invalidates every patch at once.
  useEffect(() => setCache(new Map()), [nodeId, revision]);

  useEffect(() => {
    if (nodeId === null || path === null || cache.has(key)) return;
    let alive = true;
    const controller = new AbortController();
    setError(null);
    api
      .reviewFile(nodeId, path, controller.signal)
      .then((value) => alive && setCache((prev) => new Map(prev).set(key, value)))
      .catch((e: unknown) => {
        if (alive && !controller.signal.aborted) setError(describeError(e));
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [nodeId, path, key, cache]);

  const data = cache.get(key) ?? null;
  return { data, error, loading: path !== null && data === null && error === null };
}
