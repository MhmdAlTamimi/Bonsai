import type { JSX } from 'react';

import { CopyButton } from '../../CopyButton.tsx';

/**
 * The payoff of adopting a folder: the branch is already in the user's own
 * repository, so getting at it is one command where they already are. Shown
 * for any node with commits.
 *
 * The command is built by the server and arrives ready to paste — NodeDetail
 * carries nothing git-shaped, so the interface never assembles a ref or a path.
 */
export function Checkout({ command, hint }: { command: string; hint: string | null }): JSX.Element {
  return (
    <section className="checkout-section" aria-label="Use this code outside Bonsai">
      <p className="hint">Open the committed result in your own editor or terminal.</p>
      <div className="row">
        <code className="checkout">{command}</code>
        <CopyButton text={command} label="Copy command" />
      </div>
      {hint != null && <p className="hint">{hint}</p>}
    </section>
  );
}
