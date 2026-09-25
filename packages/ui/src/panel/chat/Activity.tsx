import { type JSX, useEffect, useRef, useState } from 'react';

import { Disclosure } from './Disclosure.tsx';
import {
  isFailureLine,
  runningLabel,
  segments,
  summarise,
  toStep,
  type Step,
  type StepInput,
} from './activity-summary.ts';

/**
 * What the agent did between two things it said, as one dimmed line.
 *
 * Every stretch of tool calls folds into a summary -- "Ran 2 commands, created
 * test_header_repeats.py +24 −0 ›" -- that opens into a quiet container with a
 * row per step; a step opens in place to its file's lines or its command and
 * output. Prose stays bright and work stays dim, so the thread reads as
 * what the agent said, and a run with thirty tool calls is five lines rather
 * than thirty blocks.
 *
 * Everything starts folded, and what was opened is remembered for the rest of
 * the session, so coming back to a conversation keeps it the way it was left.
 */

/** Body lines shown before the row that shows the rest. */
const VISIBLE_LINES = 8;

/** What was opened, by group and step. Session-only, like reading positions. */
const opened = new Map<string, boolean>();

function useRemembered(key: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => opened.get(key) ?? false);
  // A different group in the same place (another conversation) reads its own.
  useEffect(() => setOpen(opened.get(key) ?? false), [key]);
  return [
    open,
    () => {
      opened.set(key, !open);
      setOpen(!open);
    },
  ];
}

export function ActivityGroup({
  id,
  steps: inputs,
}: {
  /** Unique across conversations: the run and the group's place in it. */
  id: string;
  steps: readonly StepInput[];
}): JSX.Element {
  const [open, toggle] = useRemembered(id);
  const steps = inputs.map(toStep);
  const running = [...steps].reverse().find((step) => step.live);
  const added = steps.reduce((n, step) => n + step.added, 0);
  const removed = steps.reduce((n, step) => n + step.removed, 0);
  const failed = steps.filter((step) => step.failed).length;
  return (
    <div className={`work${open ? ' open' : ''}${running ? ' live' : ''}`}>
      <button className="work-summary" aria-expanded={open} onClick={toggle}>
        <Words text={running === undefined ? summarise(steps) : runningLabel(running)} />
        {(added > 0 || removed > 0) && <Counts added={added} removed={removed} />}
        {failed > 0 && <span className="work-failed">{failed} failed</span>}
        <Caret open={open} />
      </button>
      {open && (
        <div className="work-group">
          {steps.map((step, index) => (
            <StepRow key={index} id={`${id}:${index}`} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}

function StepRow({ id, step }: { id: string; step: Step }): JSX.Element {
  const [open, toggle] = useRemembered(id);
  return (
    <div className="work-step">
      <button className="work-step-head" aria-expanded={open} onClick={toggle}>
        {step.parentToolUseId !== undefined && (
          <span className="work-sub" title={`Subagent · ${step.parentToolUseId}`}>
            subagent
          </span>
        )}
        <Words text={step.label} />
        {(step.added > 0 || step.removed > 0) && (
          <Counts added={step.added} removed={step.removed} />
        )}
        {step.failed && <span className="work-failed">failed</span>}
        {step.live && <span className="work-running">running…</span>}
        <Caret open={open} />
      </button>
      {open && (step.kind === 'command' ? <CommandBody step={step} /> : <FileBody step={step} />)}
    </div>
  );
}

/** A file: its path on a line of its own, then the lines that changed. */
function FileBody({ step }: { step: Step }): JSX.Element {
  const edit = step.result?.edit;
  const lines = edit?.lines ?? [];
  const [more, setMore] = useState(false);
  const shown = more ? lines : lines.slice(0, VISIBLE_LINES);
  return (
    <div className="work-body">
      <span className="work-path">{edit?.path ?? step.detail}</span>
      {lines.length > 0 && (
        <div className="work-code">
          <div className="work-lines">
            {shown.map((line, i) => (
              <div key={i} className={`work-line dl-${line.kind}`}>
                <span className="work-sign" aria-hidden="true">
                  {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}
                </span>
                <span className="work-num">{line.newLine ?? line.oldLine ?? ''}</span>
                <span className="work-text">{line.text === '' ? ' ' : line.text}</span>
              </div>
            ))}
          </div>
          {lines.length > VISIBLE_LINES && (
            <Disclosure
              open={more}
              lines={lines.length - VISIBLE_LINES}
              onToggle={() => setMore((v) => !v)}
            />
          )}
          {more && edit?.truncated === true && (
            <p className="work-omitted">More changed lines are in review.</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A command: `$ command` in a raised box with copy, then its output on the
 * deepest surface, the last line brighter and failure lines in the failure
 * colour.
 */
function CommandBody({ step }: { step: Step }): JSX.Element {
  const output = step.result?.output ?? [];
  const dropped = step.result?.dropped;
  const [more, setMore] = useState(false);
  const shown = more ? output : output.slice(0, VISIBLE_LINES);
  return (
    <div className="work-body">
      <div className="work-command">
        <span className="work-prompt" aria-hidden="true">
          $
        </span>
        <span className="work-command-text">{step.detail}</span>
        <CopyButton text={step.detail} />
      </div>
      {(output.length > 0 || step.live) && (
        <div className="work-code">
          <div className="work-output">
            {dropped !== undefined && (
              <div className="work-out dim">
                … {dropped.toLocaleString()} earlier line{dropped === 1 ? '' : 's'} not kept
              </div>
            )}
            {shown.map((line, i) => (
              <div
                key={i}
                className={`work-out${isFailureLine(line) ? ' fail' : i === output.length - 1 ? ' last' : ''}`}
              >
                {line}
              </div>
            ))}
            {step.live && output.length === 0 && <div className="work-out dim">running…</div>}
          </div>
          {output.length > VISIBLE_LINES && (
            <Disclosure
              open={more}
              lines={output.length - VISIBLE_LINES}
              onToggle={() => setMore((v) => !v)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** A line's words, with the file names lifted. */
function Words({ text }: { text: string }): JSX.Element {
  return (
    <span className="work-words">
      {segments(text).map((part, i) =>
        part.lifted ? (
          <strong key={i} className="work-lift">
            {part.text}
          </strong>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  );
}

function Counts({ added, removed }: { added: number; removed: number }): JSX.Element {
  return (
    <span className="work-counts">
      <span className="added">+{added}</span> <span className="removed">−{removed}</span>
    </span>
  );
}

function Caret({ open }: { open: boolean }): JSX.Element {
  return (
    <span className="work-caret" aria-hidden="true">
      {open ? '⌄' : '›'}
    </span>
  );
}

/** Copies the command: the thing someone would type again, never its output. */
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
      title="Copy command"
      aria-label="Copy command"
      onClick={copy}
    >
      <span aria-hidden="true">{state === 'copied' ? '✓' : '⧉'}</span>
      {state !== 'idle' && (
        <span className="copy-label">{state === 'copied' ? 'Copied' : 'Copy failed'}</span>
      )}
    </button>
  );
}
