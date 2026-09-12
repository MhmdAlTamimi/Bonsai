import { type JSX, useState } from 'react';
import { api } from '../api/client.ts';

/**
 * One click turns "something went wrong" into a block of text worth reading.
 *
 * Without it, investigating anything starts with a conversation -- what
 * version, what platform, where is your data directory, what does the log say
 * -- and every round of that costs a day.
 *
 * It is shown before it is copied, deliberately. Asking someone to paste a
 * blob they have not seen into a public issue is asking them to trust it, and
 * the whole reason the API key is absent is that the trust would be misplaced
 * if it were not.
 */
export function Diagnostics({ nodeId }: { nodeId: string | null }): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'copied' | 'failed'>('idle');

  const gather = async (): Promise<void> => {
    setState('loading');
    try {
      const report = await api.diagnostics(nodeId);
      const body = JSON.stringify(report, null, 2);
      setText(body);
      try {
        await navigator.clipboard.writeText(body);
        setState('copied');
      } catch {
        // No clipboard permission, or an insecure context. The text is on
        // screen and selectable, which is the point; the copy was a shortcut.
        setState('idle');
      }
    } catch {
      setState('failed');
    }
  };

  return (
    <section>
      <h4>Diagnostics</h4>
      <div className="row">
        <button disabled={state === 'loading'} onClick={() => void gather()}>
          {state === 'loading' ? 'Gathering…' : 'Copy diagnostics'}
        </button>
        {state === 'copied' && <span className="hint">Copied to the clipboard.</span>}
        {state === 'failed' && <span className="error">Could not gather diagnostics.</span>}
      </div>
      <p className="hint">
        Versions, paths, counts, the last 50 log lines. No key, no prompts, no file contents.
      </p>
      {text !== null && <pre className="stream">{text}</pre>}
    </section>
  );
}
