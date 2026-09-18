import { type JSX, useState } from 'react';
import type { MessageView } from '@bonsai/shared';

/**
 * The tool calls that are not the story: reads, searches, listings.
 *
 * A real run makes twenty to forty of them, and every one used to be its own
 * monospace line at the same indent as the reply you were trying to read. They
 * are one dim line now -- "Read ×6 · Grep ×2" -- which is what a reader needs
 * from them: how much looking happened before the change. The detail is one
 * click away and stays closed until asked for.
 *
 * Commands and edits are not here: they carry what they produced, so they are
 * blocks of their own (see ToolBlock).
 */
export function QuietTools({ calls }: { calls: readonly MessageView[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={`quiet-tools${open ? ' open' : ''}`}>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        {summarise(calls)}
      </button>
      {open && (
        <ol>
          {calls.map((call) => {
            const tool = call.content as { name?: string; detail?: string };
            return (
              <li key={call.id}>
                <span className="quiet-name">{tool.name ?? 'tool'}</span>
                <span className="quiet-detail" title={tool.detail}>
                  {tool.detail}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** "Read ×6 · Grep ×2": how much looking happened, in the width of one line. */
function summarise(calls: readonly MessageView[]): string {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const name = (call.content as { name?: string }).name ?? 'tool';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => (n === 1 ? name : `${name} ×${n}`))
    .join(' · ');
}
