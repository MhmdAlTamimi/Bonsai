import { useEffect, useState } from 'react';
import type { AttentionView } from '@bonsai/shared';
import { api, subscribe } from '../api/client.ts';

/** Waiting questions matter even when their project is not the one on screen. */
export function useAttention(): AttentionView[] {
  const [items, setItems] = useState<AttentionView[]>([]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let revision = 0;
    const load = (): void => {
      clearTimeout(timer);
      const ticket = ++revision;
      void api
        .attention()
        .then((rows) => {
          if (alive && ticket === revision) setItems(rows);
        })
        .catch(() => undefined);
    };
    const soon = (): void => {
      clearTimeout(timer);
      timer = setTimeout(load, 100);
    };
    const unsubscribe = subscribe(
      '*',
      (event) => {
        if (['run.question', 'node.status', 'run.finished', 'tree.updated'].includes(event.type))
          soon();
      },
      (state) => {
        if (state === 'live') load();
      },
    );
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    document.title = items.length ? `(${items.length}) Needs you · Bonsai` : 'Bonsai';
    return () => {
      document.title = 'Bonsai';
    };
  }, [items.length]);
  return items;
}
