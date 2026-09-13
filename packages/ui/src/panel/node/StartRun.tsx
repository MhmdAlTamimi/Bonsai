import { type JSX, useState } from 'react';
import type { NodeView } from '@bonsai/shared';

/**
 * PRD §5: what a `new` node's panel is supposed to offer.
 *
 * It offered none of it. A node that had not run yet showed the same chat box
 * as every other node, so the first screen after creating a project -- one card
 * reading "not started", an empty canvas -- had no next step on it at all. The
 * only way forward was to guess that typing into the composer would start the
 * run.
 *
 * The description is pre-filled and editable, because by the time you are
 * looking at this you may well have thought of something better than what you
 * typed on the project form.
 */
export function StartRun({
  node,
  busy,
  onStart,
}: {
  node: NodeView;
  busy: boolean;
  onStart: (prompt: string) => void;
}): JSX.Element {
  const [prompt, setPrompt] = useState(node.summaryLine);

  return (
    <section className="start">
      <h3>Nothing has run here yet</h3>
      <p className="hint">
        {node.parentId === null
          ? 'Start the first run to scaffold this project from its description.'
          : 'Start this node to hand the description to an agent.'}
      </p>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        aria-label="what this node should do"
        placeholder="What should this node do?"
        rows={3}
      />
      <div className="row">
        <button
          className="primary"
          disabled={busy || prompt.trim() === ''}
          onClick={() => onStart(prompt)}
        >
          {busy ? 'Starting…' : 'Start'}
        </button>
        <span className="hint">Costs a run. The node stays editable while it is a leaf.</span>
      </div>
    </section>
  );
}
