import { type JSX, useState } from 'react';

/**
 * The payoff of adopting a folder: the branch is already in the user's own
 * repository, so getting at it is one command where they already are. Shown
 * for any node with commits.
 *
 * The command is built by the server and arrives ready to paste — NodeDetail
 * carries nothing git-shaped, so the interface never assembles a ref or a path.
 */
export function Checkout({
  command,
  hint,
  onError,
}: {
  command: string;
  hint: string | null;
  onError: (message: string) => void;
}): JSX.Element {
  const [copied, setCopied] = useState(false);

  return (
    <section>
      <h3>Get this branch</h3>
      <div className="row">
        <code className="checkout">{command}</code>
        <button
          className="linkish"
          onClick={() => {
            void navigator.clipboard
              .writeText(command)
              .then(() => setCopied(true))
              .catch(() => onError('Could not copy — select the command instead.'));
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      {hint != null && <p className="hint">{hint}</p>}
    </section>
  );
}
