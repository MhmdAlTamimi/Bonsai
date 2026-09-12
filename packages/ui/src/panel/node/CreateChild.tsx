import type { JSX } from 'react';

import type { useNodeActions } from './useNodeActions.ts';

/**
 * D5: to make a change you explicitly create a child.
 *
 * The canvas gesture — drag out of a handle — is the primary way, and asks the
 * success-criteria questions too. This is the keyboard-reachable version for
 * when the node you want to branch from is the one already in front of you.
 */
export function CreateChild({
  actions,
}: {
  actions: ReturnType<typeof useNodeActions>;
}): JSX.Element {
  return (
    <details className="disclosure">
      <summary>Create a child</summary>
      <input
        value={actions.childName}
        onChange={(e) => actions.setChildName(e.target.value)}
        placeholder="name"
        aria-label="child name"
      />
      <textarea
        value={actions.childDesc}
        onChange={(e) => actions.setChildDesc(e.target.value)}
        placeholder="what should change?"
        aria-label="child description"
        rows={3}
      />
      <button disabled={actions.busy} onClick={() => void actions.createChild()}>
        Create and run
      </button>
      <p className="hint">
        A child forks this node's whole conversation, and branches from the nearest ancestor that
        has a commit — which is not this node if it changed no files.
      </p>
    </details>
  );
}
