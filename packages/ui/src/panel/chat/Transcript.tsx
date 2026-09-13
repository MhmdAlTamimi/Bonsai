import { type JSX, useEffect, useState } from 'react';
import type { DiffView, MessageView, RunView } from '@bonsai/shared';

import { api } from '../../api/client.ts';
import { Diff } from './Diff.tsx';
import { Markdown } from './Markdown.tsx';
import { ToolCalls } from './ToolCalls.tsx';
import { relativeTime, exactTime } from './time.ts';
import type { Delta } from './liveMerge.ts';

/**
 * The conversation, grouped into the turns that actually happened.
 *
 * The transcript used to be a flat list of `.msg` divs distinguished only by
 * shade of grey and font size: your prompt in a rounded box, the reply in the
 * dimmer of two greys, and every tool call as its own monospace line at the
 * same indent. Three of the four kinds were left-aligned text at two pixels of
 * padding, separated by a uniform eight-pixel gap, so there was no visible
 * boundary between one exchange and the next.
 *
 * The fix is not more styling, it is the right unit. A run -- one prompt, the
 * work it caused, the reply, and the commit it produced -- is what the user
 * reasons about, what carries a cost, and what has a diff. So a run is a block,
 * with its own header, body and footer, and the panel renders a list of those
 * rather than a list of messages. `runId` was already on every message; nothing
 * new had to be stored to do this.
 */
export function Transcript({
  messages,
  runs,
  pending,
  running,
}: {
  messages: readonly MessageView[];
  runs: readonly RunView[];
  /** Live deltas the persisted transcript has not caught up with. */
  pending: readonly Delta[];
  running: boolean;
}): JSX.Element {
  const runsById = new Map(runs.map((r) => [r.id, r]));
  const groups = groupByRun(messages);
  const pendingRunId = pending[0]?.runId ?? null;

  // A run can stream before any of its messages have landed, which would leave
  // the live text with no turn to sit in. Rare and brief, but it reads as the
  // output vanishing, so the turn is opened early with nothing in it.
  if (pendingRunId !== null && !groups.some((g) => g.runId === pendingRunId)) {
    groups.push({ runId: pendingRunId, messages: [] });
  }

  return (
    <div className="transcript">
      {groups.map((group) => (
        <Turn
          key={group.runId ?? 'unattached'}
          group={group}
          run={group.runId === null ? undefined : runsById.get(group.runId)}
          pending={group.runId === pendingRunId ? pending : []}
          running={running && group.runId === pendingRunId}
        />
      ))}
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

function Turn({
  group,
  run,
  pending,
  running,
}: {
  group: Group;
  run: RunView | undefined;
  pending: readonly Delta[];
  running: boolean;
}): JSX.Element {
  const prompt = group.messages.find((m) => m.role === 'user');
  const body = group.messages.filter((m) => m !== prompt);
  const when = prompt?.createdAt ?? run?.startedAt ?? null;

  return (
    <article className={`turn ${running ? 'live' : ''}`}>
      {prompt !== undefined && (
        <header className="turn-head">
          <span className="turn-who">You</span>
          {when !== null && (
            <time className="turn-when" title={exactTime(when)}>
              {relativeTime(when)}
            </time>
          )}
        </header>
      )}
      {prompt !== undefined && <div className="turn-prompt">{asText(prompt.content)}</div>}

      <div className="turn-reply">
        {segment(body).map((part, i) =>
          part.kind === 'tools' ? (
            <ToolCalls key={i} calls={part.messages} live={running} />
          ) : (
            part.messages.map((m) => <Said key={m.id} message={m} />)
          ),
        )}

        {pending.map((delta, i) => (
          <div key={`live-${i}`} className={delta.seq === 0 ? 'said system' : 'said streaming'}>
            {delta.seq === 0 ? <pre>{delta.text}</pre> : <Markdown source={delta.text} />}
          </div>
        ))}

        {running && (
          <div className="working" aria-live="polite">
            <span className="working-dot" aria-hidden="true" />
            working&hellip;
          </div>
        )}
      </div>

      {!running && run !== undefined && <TurnFoot run={run} />}
    </article>
  );
}

function Said({ message }: { message: MessageView }): JSX.Element {
  const text = asText(message.content);
  if (message.role === 'system') {
    return (
      <div className="said system">
        <pre>{text}</pre>
      </div>
    );
  }
  return (
    <div className="said assistant">
      <Markdown source={text} />
    </div>
  );
}

interface Part {
  kind: 'tools' | 'prose';
  messages: MessageView[];
}

/**
 * Consecutive tool calls, gathered; everything else left where it is.
 *
 * See ToolCalls for why this is done per run of adjacent calls rather than once
 * per turn: the prose between two bursts of tool use is the part worth reading,
 * and hoisting all the calls to the top would strand it.
 */
function segment(messages: readonly MessageView[]): Part[] {
  const parts: Part[] = [];
  for (const message of messages) {
    const kind = message.kind === 'tool_use' ? 'tools' : 'prose';
    const last = parts[parts.length - 1];
    if (last?.kind === kind) last.messages.push(message);
    else parts.push({ kind, messages: [message] });
  }
  return parts;
}

/**
 * What the run cost and what it produced.
 *
 * Only once the run has ended: a run still in flight has no verdict, and this
 * used to render "answered - no commit" the moment the agent produced its first
 * message, which is a plain lie about a run that is still working.
 */
function TurnFoot({ run }: { run: RunView }): JSX.Element | null {
  if (run.status === 'running') return null;

  if (run.status === 'failed' || run.status === 'cancelled') {
    return <footer className="turn-foot failed">{run.error ?? run.status}</footer>;
  }

  const seconds = run.durationMs === null ? null : (run.durationMs / 1000).toFixed(1);

  return (
    <footer className="turn-foot">
      {run.commitSha === null ? (
        <span title="This reply answered without editing files, so it added no commit.">
          no commit
        </span>
      ) : (
        <RunDiff runId={run.id} />
      )}
      <span className="turn-stats">
        {seconds !== null && <span title="Wall-clock time for this run">{seconds}s</span>}
        {run.toolCalls > 0 && (
          <span title={run.toolsOffered?.join(', ') ?? 'Tools offered were not recorded.'}>
            {run.toolCalls} tool{run.toolCalls === 1 ? '' : 's'}
          </span>
        )}
        {run.costUsd > 0 && (
          <span title="Estimated from token counts at list prices. Not a bill.">
            ${run.costUsd.toFixed(3)}
          </span>
        )}
        {run.model !== null && <span className="turn-model">{run.model}</span>}
      </span>
    </footer>
  );
}

function RunDiff({ runId }: { runId: string }): JSX.Element {
  const [diff, setDiff] = useState<DiffView | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void api
      .runDiff(runId)
      .then((d) => alive && setDiff(d))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open, runId]);

  return (
    <>
      <button className="turn-diff-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>{' '}
        {diff === null ? 'Changes' : `Changes · ${diff.files.length} file(s)`}
      </button>
      {open && diff !== null && (
        <div className="turn-diff">
          <Diff patch={diff.patch} dirty={diff.dirty} />
        </div>
      )}
    </>
  );
}

/** Content is `unknown` on the wire; anything non-string is shown, not hidden. */
function asText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}
