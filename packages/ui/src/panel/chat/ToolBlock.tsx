import { type JSX, useEffect, useRef, useState } from 'react';
import type { ToolResultContent } from '@bonsai/shared';

import { Disclosure } from './Disclosure.tsx';

/**
 * One bounded block for everything a machine produced.
 *
 * READ, RUN and EDIT share a shell because they answer the same question at
 * different grain: what was looked at, what was run and what it printed, what
 * was changed and which lines moved. Nothing else in the panel renders a path,
 * a command or a patch.
 *
 * Bounded is the point. Eight lines, never a scroller of its own, never
 * wrapped: the panel has ONE scroll, and a block that grows without limit is
 * how a forty-line build log ate a conversation. The rest is one disclosure
 * away, and the whole change is read in review.
 */

/** How many body lines a block shows before the disclosure takes over. */
const VISIBLE_LINES = 8;

const RUN_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export type ToolKind = 'READ' | 'RUN' | 'EDIT' | 'TOOL';

/** Which of the three a call is, from what it produced rather than its name. */
export function kindOf(name: string, result: ToolResultContent | undefined): ToolKind {
  if (result?.edit !== undefined || EDIT_TOOLS.has(name)) return 'EDIT';
  if (result?.output !== undefined || RUN_TOOLS.has(name)) return 'RUN';
  return ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'].includes(name) ? 'READ' : 'TOOL';
}

export function ToolBlock({
  name,
  parentToolUseId,
  detail,
  result,
  live,
}: {
  name: string;
  parentToolUseId?: string | undefined;
  /** The command, or the file path: the one line that identifies the call. */
  detail: string;
  result: ToolResultContent | undefined;
  /** The call has not come back yet. */
  live: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const kind = kindOf(name, result);
  const edit = result?.edit;
  const output = result?.output ?? [];

  const total = kind === 'EDIT' ? (edit?.lines.length ?? 0) : output.length;
  const hidden = Math.max(0, total - VISIBLE_LINES);
  // The tail of a command is how it went; the head of a patch is where it
  // starts. Each keeps the end that carries the meaning.
  const shownLines = open
    ? undefined
    : kind === 'RUN'
      ? { from: Math.max(0, total - VISIBLE_LINES) }
      : { to: VISIBLE_LINES };

  return (
    <div className={`tool-block kind-${kind.toLowerCase()}`}>
      <header className="tool-head">
        <span className="tool-kind">{kind}</span>
        {parentToolUseId && <span title={`Parent tool call: ${parentToolUseId}`}>Subagent</span>}
        <span className={`tool-subject${kind === 'RUN' ? '' : ' path'}`} title={detail}>
          {kind === 'RUN' ? detail : shortPath(edit?.path ?? detail, kind)}
        </span>
        {kind === 'RUN' && result !== undefined && (
          <span className={`tool-tally ${result.ok ? 'added' : 'removed'}`}>
            {result.ok ? '0' : 'error'}
          </span>
        )}
        {edit !== undefined && (
          <>
            <span className="tool-tally added">+{edit.added}</span>
            {edit.removed > 0 && <span className="tool-tally removed">−{edit.removed}</span>}
          </>
        )}
        <CopyButton text={copyText(kind, detail, result)} />
      </header>

      {(total > 0 || (live && kind === 'RUN')) && (
        <div className="tool-body">
          {kind === 'EDIT'
            ? (edit?.lines ?? []).slice(shownLines?.from ?? 0, shownLines?.to).map((line, i) => (
                <div key={i} className={`tool-line dl-${line.kind}`}>
                  <span className="tool-num">{line.newLine ?? line.oldLine ?? ''}</span>
                  <span className="tool-sign" aria-hidden="true">
                    {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                  </span>
                  <span className="tool-text">{line.text === '' ? ' ' : line.text}</span>
                </div>
              ))
            : output.slice(shownLines?.from ?? 0, shownLines?.to).map((line, i) => (
                <div key={i} className="tool-line">
                  <span className="tool-gutter" aria-hidden="true">
                    ›
                  </span>
                  <span className="tool-text">{line}</span>
                </div>
              ))}
          {live && output.length === 0 && (
            <div className="tool-line">
              <span className="tool-gutter" aria-hidden="true">
                ›
              </span>
              <span className="tool-text muted">running…</span>
            </div>
          )}
        </div>
      )}

      {hidden > 0 && <Disclosure open={open} lines={hidden} onToggle={() => setOpen((v) => !v)} />}
      {/* What never reached Bonsai at all, said once, at the bottom. */}
      {open && (result?.dropped !== undefined || edit?.truncated === true) && (
        <p className="tool-omitted">
          {result?.dropped !== undefined
            ? `${result.dropped.toLocaleString()} earlier line${result.dropped === 1 ? '' : 's'} were not kept`
            : 'More changed lines are in review'}
        </p>
      )}
    </div>
  );
}

/**
 * Copy: the command for RUN, the path for READ, the patch fragment for EDIT.
 *
 * Never the output. What someone wants from a block is the thing they would
 * type again or paste into a message, and output is what they can already see.
 */
function copyText(kind: ToolKind, detail: string, result: ToolResultContent | undefined): string {
  if (kind !== 'EDIT') return detail;
  const edit = result?.edit;
  if (edit === undefined) return detail;
  return [
    edit.path,
    ...edit.lines.map(
      (line) => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`,
    ),
  ].join('\n');
}

/** Always there, so the block is never a thing you have to select by hand. */
function CopyButton({ text }: { text: string }): JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (): void => {
    clearTimeout(timer.current);
    setState('idle');
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setState('copied');
        // Long enough to notice, short enough not to become part of the block.
        timer.current = setTimeout(() => setState('idle'), 1_200);
      })
      // A failure stays: it is news, and it means the text is still only here.
      .catch(() => setState('failed'));
  };
  return (
    <button
      className={`tool-copy${state === 'idle' ? '' : ` ${state}`}`}
      title="Copy"
      aria-label="Copy"
      onClick={copy}
    >
      <span aria-hidden="true">{state === 'copied' ? '✓' : '⧉'}</span>
      {state !== 'idle' && (
        <span className="copy-label">{state === 'copied' ? 'Copied' : 'Copy failed'}</span>
      )}
    </button>
  );
}

/**
 * A filename, not a path to it (§4: no absolute paths in the panel).
 *
 * An edit says the file alone; a read keeps one folder for context, and what
 * is trimmed is the FRONT — the end of a path is the part that identifies it.
 */
function shortPath(value: string, kind: ToolKind): string {
  if (!value.includes('/')) return value;
  const parts = value.split('/').filter((part) => part !== '');
  if (kind === 'EDIT') return parts.at(-1) ?? value;
  return parts.slice(-2).join('/');
}
