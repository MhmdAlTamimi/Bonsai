import { useEffect, useState } from 'react';
import type { NodeDetail } from '@bonsai/shared';

import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';

/**
 * One experiment's detail, fetched by whoever is showing it.
 *
 * The panel keeps its own copy because it needs it on every render; this is
 * for the surfaces that need it only while they are open -- the card's details
 * dialog and the review screen's menu -- so nothing loads node facts for a
 * screen that is not asking for them.
 */
export function useNodeDetail(
  nodeId: string | null,
  revision: unknown = '',
): { data: NodeDetail | null; error: string | null } {
  const [data, setData] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (nodeId === null) return;
    let alive = true;
    const controller = new AbortController();
    setError(null);
    void api
      .node(nodeId, controller.signal)
      .then((detail) => alive && setData(detail))
      .catch((e: unknown) => alive && setError(describeError(e)));
    return () => {
      alive = false;
      controller.abort();
    };
  }, [nodeId, revision]);
  return { data, error };
}
