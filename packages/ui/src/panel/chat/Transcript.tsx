import { type JSX, useLayoutEffect, useRef, useState } from 'react';
import type { MessageView, RunView, ToolResultContent } from '@bonsai/shared';

import { Markdown } from './Markdown.tsx';
import { ToolBlock } from './ToolBlock.tsx';
import { Disclosure } from './Disclosure.tsx';
import { exactTime, clockTime } from './time.ts';
import type { Delta } from './liveMerge.ts';

/**
 * The conversation, as runs.
 *
 * A run -- one request, the work it caused, the reply -- is what the user
 * reasons about, what carries a cost, and what produced a change, so it is the
 * unit here. Inside one, the asymmetry is deliberate: your message is an
 * object you can see, and the agent's reply is text on the panel, because one
 * of you is quoting a request and the other is answering at length.
 *
 * Every tool call is one bounded block, in place, in the order it happened: a
 * READ is its 30px header alone, a RUN carries the end of its output, an EDIT
 * the lines that moved. They used to be summarised into "Read ×6 · Grep ×2",
 * which hid WHICH file was read at the moment it mattered -- and the narration
 * between bursts, which is the readable part, lost its anchors.
 */
export function Transcript({
  messages,
  runs,
  pending,
  running,
  waiting = false,
  onProjectSettings,
}: {
  messages: readonly MessageView[];
  runs: readonly RunView[];
  /** Live deltas the persisted transcript has not caught up with. */
  pending: readonly Delta[];
  running: boolean;
  /** The live run's turn is over and it is waiting for background work (D43). */
  waiting?: boolean;
  onProjectSettings?: () => void;
}): JSX.Element {
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const numberOf = new Map(runs.map((run, index) => [run.id, index + 1]));
  const groups = groupByRun([...messages, ...liveMessages(pending)]);
  const liveRunId = pending.at(-1)?.runId ?? null;

  return (
    <div className="thread">
      {groups.map((group) =>
        group.runId === null ? (
          <SetupActivity
            key="setup"
            messages={group.messages}
            onProjectSettings={onProjectSettings}
          />
        ) : (
          <Turn
            key={group.runId}
            group={group}
            run={runsById.get(group.runId)}
            number={numberOf.get(group.runId) ?? null}
            running={
              running &&
              (group.runId === liveRunId || runsById.get(group.runId)?.status === 'running')
            }
            waiting={waiting}
          />
        ),
      )}
    </div>
  );
}

interface Group {
  runId: string | null;
  messages: MessageView[];
}

/** Messages in order, cut at each change of run. */
function groupByRun(messages: readonly MessageView[]): Group[] {
  const groups: Group[] = [];
  for (const message of messages) {
    const last = groups[groups.length - 1];
    if (last?.runId === message.runId) last.messages.push(message);
    else groups.push({ runId: message.runId, messages: [message] });
  }
  return groups;
}

/** Live frames, as the messages they will be once the run persists them. */
function liveMessages(pending: readonly Delta[]): MessageView[] {
  return pending.map((delta, index) => ({
    id: `live-${delta.runId}-${delta.seq}-${index}`,
    nodeId: '',
    runId: delta.runId,
    seq: delta.seq,
    role: delta.seq === 0 ? 'system' : 'assistant',
    kind: delta.toolResult ? 'tool_result' : delta.tool ? 'tool_use' : 'text',
    content: delta.toolResult ?? delta.tool ?? delta.text,
    createdAt: '',
  }));
}

function Turn({
  group,
  run,
  number,
  running,
  waiting,
}: {
  group: Group;
  run: RunView | undefined;
  number: number | null;
  running: boolean;
  waiting: boolean;
}): JSX.Element {
  const { prompt, rest } = splitPrompt(group.messages);
  const parts = compose(rest);
  const when = prompt?.createdAt ?? run?.startedAt ?? null;

  return (
    <article className={`turn${running ? ' live' : ''}`}>
      {number !== null && number > 1 && (
        <div className="run-divider">
          <span className="run-label">RUN {number}</span>
          <span className="run-rule" />
          {when !== null && (
            <time className="run-when" title={exactTime(when)}>
              {clockTime(when)}
            </time>
          )}
        </div>
      )}

      {prompt !== undefined && <YouSaid message={prompt} />}

      {(parts.length > 0 || running) && (
        <div className="msg agent">
          <span className="msg-label">Agent:</span>
          {parts.map((part, i) =>
            part.kind === 'block' ? (
              <ToolBlock
                key={i}
                name={part.name}
                detail={part.detail}
                parentToolUseId={part.parentToolUseId}
                result={part.result}
                live={running && part.result === undefined}
              />
            ) : part.kind === 'you' ? (
              <YouSaid key={i} message={part.message} inline />
            ) : (
              <Said key={i} message={part.message} />
            ),
          )}
          {running && (
            <div className="working" aria-live="polite">
              <span className="working-dot" aria-hidden="true" />
              {waiting ? 'waiting for background work' : 'working'}&hellip;
            </div>
          )}
        </div>
      )}

      {run?.resolvedContext && (
        <details className="run-context">
          <summary>Run context</summary>
          <dl>
            <dt>Code revision</dt>
            <dd>
              <code>{run.resolvedContext.codeCommit ?? 'None'}</code>
            </dd>
            <dt>Parent conversation</dt>
            <dd>
              {run.resolvedContext.parentNodeId
                ? `${run.resolvedContext.parentName ?? 'Parent'} · available through message ${run.resolvedContext.parentMessageSeq}`
                : 'No parent'}
            </dd>
            <dt>Resolved</dt>
            <dd>{run.resolvedContext.resolvedAt}</dd>
            {run.resolvedContext.parentSnapshotSha256 && (
              <>
                <dt>Snapshot fingerprint</dt>
                <dd>
                  <code>{run.resolvedContext.parentSnapshotSha256}</code>
                </dd>
              </>
            )}
          </dl>
        </details>
      )}
      {!running && run !== undefined && <RunFoot run={run} />}
    </article>
  );
}

/**
 * The request, and everything after it.
 *
 * Found rather than assumed to be first: a resumed run writes its system note
 * before the prompt, and the turn still opens with what was asked.
 */
function splitPrompt(messages: readonly MessageView[]): {
  prompt: MessageView | undefined;
  rest: MessageView[];
} {
  const index = messages.findIndex((m) => m.role === 'user');
  if (index === -1) return { prompt: undefined, rest: [...messages] };
  return { prompt: messages[index], rest: messages.filter((_, i) => i !== index) };
}

type Part =
  | { kind: 'said'; message: MessageView }
  | { kind: 'you'; message: MessageView }
  | {
      kind: 'block';
      name: string;
      detail: string;
      parentToolUseId: string | undefined;
      result: ToolResultContent | undefined;
    };

/** Pairs each call with what it produced, and folds the quiet ones together. */
function compose(messages: readonly MessageView[]): Part[] {
  const results = new Map<string, ToolResultContent>();
  for (const message of messages) {
    if (message.kind !== 'tool_result') continue;
    const result = message.content as ToolResultContent | null;
    if (typeof result?.toolUseId === 'string') results.set(result.toolUseId, result);
  }

  const parts: Part[] = [];
  for (const message of messages) {
    if (message.kind === 'tool_result') continue;
    if (message.kind === 'tool_use') {
      const call = message.content as {
        name?: string;
        detail?: string;
        id?: string;
        parentToolUseId?: string;
      };
      parts.push({
        kind: 'block',
        name: call.name ?? 'tool',
        detail: call.detail ?? '',
        parentToolUseId: call.parentToolUseId,
        result: call.id === undefined ? undefined : results.get(call.id),
      });
      continue;
    }
    parts.push(message.role === 'user' ? { kind: 'you', message } : { kind: 'said', message });
  }
  return parts;
}

/**
 * What happened before the conversation did: the setup commands a new
 * experiment ran. One disclosure row, the same one blocks use.
 */
function SetupActivity({
  messages,
  onProjectSettings,
}: {
  messages: readonly MessageView[];
  onProjectSettings?: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={`setup-activity${open ? ' open' : ''}`}>
      <Disclosure open={open} label="Experiment setup" onToggle={() => setOpen((v) => !v)} />
      {open && (
        <>
          {messages.map((message) => (
            <Said key={message.id} message={message} />
          ))}
          {onProjectSettings && (
            <button className="linkish" onClick={onProjectSettings}>
              Project setup settings
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Your own words: an object on the panel, labelled, so the thread has two voices. */
function YouSaid({
  message,
  inline = false,
}: {
  message: MessageView;
  inline?: boolean;
}): JSX.Element {
  return (
    <div className={`msg you${inline ? ' inline' : ''}`}>
      <span className="msg-label">You:</span>
      <Clamped text={asText(message.content)} />
    </div>
  );
}

/** How many lines of your own request the panel shows before folding the rest. */
const PROMPT_LINES = 6;

/**
 * A request, clamped.
 *
 * An inherited task runs to twenty lines of boilerplate before it says
 * anything, and the panel used to open on all of it -- the reply you came to
 * read pushed off the bottom by the request you already know. Six lines, then
 * the same disclosure row as everything else.
 */
function Clamped({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(0);
  const body = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = body.current;
    if (element === null || open) return;
    const measure = (): void => {
      const line = Number.parseFloat(getComputedStyle(element).lineHeight) || 20;
      setHidden(Math.max(0, Math.round((element.scrollHeight - element.clientHeight) / line)));
    };
    measure();
    // The panel is resizable and has three widths, and a rewrap changes how
    // much is hidden -- so the count is measured again when the box changes.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, open]);

  return (
    <div
      className={`msg-box${open ? ' open' : ''}`}
      style={{ ['--clamp' as string]: PROMPT_LINES }}
    >
      <div className="msg-body" ref={body}>
        {text}
      </div>
      {hidden > 0 && <Disclosure open={open} lines={hidden} onToggle={() => setOpen((v) => !v)} />}
    </div>
  );
}

/** Anything said without a box: the agent's prose, or a note from Bonsai. */
function Said({ message }: { message: MessageView }): JSX.Element {
  const text = asText(message.content);
  if (message.role === 'system') return <p className="msg system">{text}</p>;
  return <Markdown source={text} />;
}

/**
 * How a run ended, in one line.
 *
 * Time, cost and model when it finished; what happened instead when it did not
 * (D45). What it CHANGED is deliberately not here -- that is what review is
 * for, and repeating it under every turn is the redundancy this panel was
 * rebuilt to remove.
 */
function RunFoot({ run }: { run: RunView }): JSX.Element | null {
  if (run.status === 'running') return null;

  if (run.status === 'failed' || run.status === 'cancelled') {
    const said =
      run.endReason === 'app_closed'
        ? 'Bonsai closed while this run was working'
        : run.endReason === 'stopped'
          ? 'You stopped this run'
          : 'Failed';
    return (
      <p className="run-foot failed">
        {said}
        {run.error !== null ? ` — ${run.error}` : ''}
      </p>
    );
  }

  const parts = [
    run.durationMs === null ? null : duration(run.durationMs),
    run.costUsd > 0 ? `$${run.costUsd.toFixed(2)}` : null,
    run.model,
  ].filter((part): part is string => part !== null && part !== '');
  if (parts.length === 0) return null;

  return (
    <p className="run-foot">
      {parts.map((part, i) => (
        <span key={part}>
          {i > 0 && <span className="sep">·</span>}
          {part}
        </span>
      ))}
    </p>
  );
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** Content is `unknown` on the wire; anything non-string is shown, not hidden. */
function asText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}
