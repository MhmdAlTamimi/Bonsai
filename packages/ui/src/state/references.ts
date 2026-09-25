import { createContext, useContext, useEffect, useState } from 'react';
import type { NodeView, ReferenceView, RunReferenceView } from '@bonsai/shared';

import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';

/**
 * The project's references, and one way to open the reference dialog, for
 * everything that needs either: the composer's `@`, the transcript's chips,
 * Save as reference on a message, the card's menu. A context because those
 * sit in unrelated corners of the tree, and the dialog belongs to the window.
 */

/** What the reference dialog should show. */
export type ReferenceTarget =
  | { kind: 'library' }
  | { kind: 'edit'; id: string }
  /** A new one: blank, or seeded from a message, a node, or both. */
  | {
      kind: 'new';
      content?: string;
      sourceNodeId?: string | null;
      /** Drawn from a comparison instead: saved as its source, and what Fill reads. */
      comparison?: { id: string; title: string };
      draft?: boolean;
    }
  /** Exactly what a run was given, which may be older than the reference now. */
  | { kind: 'snapshot'; runId: string; reference: RunReferenceView };

export interface References {
  list: readonly ReferenceView[];
  byId: ReadonlyMap<string, ReferenceView>;
  open: (target: ReferenceTarget) => void;
}

export const ReferencesContext = createContext<References>({
  list: [],
  byId: new Map(),
  open: () => undefined,
});

export const useReferences = (): References => useContext(ReferencesContext);

/**
 * The open project's references, fetched again whenever the server says they
 * changed. The server owns them; nothing here edits the list locally. A list
 * is only ever returned for the project it was fetched for, so switching
 * projects shows nothing rather than the last project's references.
 */
export function useProjectReferences(
  projectId: string | null,
  revision: number,
  onError: (message: string) => void,
): readonly ReferenceView[] {
  const [loaded, setLoaded] = useState<{ projectId: string; list: ReferenceView[] } | null>(null);
  useEffect(() => {
    if (projectId === null) return;
    let alive = true;
    api
      .references(projectId)
      .then((list) => {
        if (alive) setLoaded({ projectId, list });
      })
      .catch((e: unknown) => {
        if (alive) onError(describeError(e));
      });
    return () => {
      alive = false;
    };
    // `onError` is a reporter whose identity does not matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, revision]);
  return loaded !== null && loaded.projectId === projectId ? loaded.list : NONE;
}

const NONE: readonly ReferenceView[] = [];

/**
 * Whether an experiment has a conversation of its own to draw a reference
 * from. One copied from its parent does not count: that belongs to the parent,
 * and drafting reads only the experiment's own messages.
 */
export const canDrawFrom = (node: NodeView): boolean => node.status !== 'new';

/** "1.2k chars" -- the size of a reference, for chips and lists. */
export function referenceSize(size: number): string {
  return size >= 1000 ? `${(size / 1000).toFixed(1)}k chars` : `${size} chars`;
}
