import type { JSX } from 'react';
import { deriveNodeName } from '@bonsai/shared';

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
      <textarea
        value={actions.childDesc}
        onChange={(e) => actions.setChildDesc(e.target.value)}
        placeholder="What should change?"
        aria-label="child description"
        rows={3}
      />
      {/* Optional, and second: the name is derived from the description unless
          this is filled in. Asking for it first was the friction. */}
      <input
        value={actions.childName}
        onChange={(e) => actions.setChildName(e.target.value)}
        placeholder={deriveNodeName(actions.childDesc, 'name (optional)')}
        aria-label="child name"
      />
      <button
        className="primary"
        disabled={actions.busy}
        onClick={() => void actions.createChild()}
      >
        Create and run
      </button>
      <p className="hint">Forks this node's conversation. Branches from its nearest commit.</p>
    </details>
  );
}
