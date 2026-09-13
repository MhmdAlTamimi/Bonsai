import { type JSX, useState } from 'react';
import type { MessageView } from '@bonsai/shared';

/**
 * A run of consecutive tool calls, collapsed to one line.
 *
 * This is the single biggest change to how a transcript reads. A real run makes
 * twenty to forty tool calls, and every one of them used to be its own line of
 * 11px monospace at the same indent as the agent's prose -- so the reply you
 * actually wanted to read was a few sentences scattered through a wall of
 * `Read`, `Edit` and `Bash`.
 *
 * Consecutive calls only, deliberately. Hoisting every tool call in the run into
 * one block at the top would be tidier and would destroy the narration: the
 * agent says what it is about to do, does it, then says what it found, and that
 * order is the readable part.
 *
 * Open while the run is live -- watching it work is the point of streaming --
 * and closed once it is done, when re-reading the log is rarely what you want.
 * A click pins it either way, because a rule that keeps reopening something you
 * closed is worse than no rule.
 */
export function ToolCalls({
  calls,
  live,
}: {
  calls: readonly MessageView[];
  /** Whether the run these belong to is still going. */
  live: boolean;
}): JSX.Element {
  const [pinned, setPinned] = useState<boolean | null>(null);
  const open = pinned ?? live;

  return (
    <div className={`tools ${open ? 'open' : ''}`}>
      <button
        className="tools-head"
        onClick={() => setPinned(!open)}
        aria-expanded={open}
        title={open ? 'Hide the tool calls' : 'Show what it did'}
      >
        <span className="tools-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span>
          {calls.length} tool call{calls.length === 1 ? '' : 's'}
        </span>
        {!open && <span className="tools-names">{summarise(calls)}</span>}
      </button>
      {open && (
        <ol className="tools-list">
          {calls.map((call) => {
            const tool = call.content as { name?: string; detail?: string };
            return (
              <li key={call.id}>
                <span className="tool-name">{tool.name ?? 'tool'}</span>
                {tool.detail !== undefined && tool.detail !== '' && (
                  <span className="tool-detail" title={tool.detail}>
                    {tool.detail}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/**
 * "Read ×6 · Edit ×4 · Bash ×2" -- what the collapsed line has to say to be
 * worth collapsing to. A run that never used Write explains itself instantly,
 * which is the question this data was captured to answer.
 */
function summarise(calls: readonly MessageView[]): string {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const name = (call.content as { name?: string }).name ?? 'tool';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, n]) => (n === 1 ? name : `${name} ×${n}`))
    .join(' · ');
}
