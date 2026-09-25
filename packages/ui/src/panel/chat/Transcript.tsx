import { type JSX, useLayoutEffect, useRef, useState } from 'react';
import type {
  CompactionNote,
  MessageView,
  RunActivity,
  RunExperimentView,
  RunReferenceView,
  RunView,
  ToolResultContent,
} from '@bonsai/shared';

import { Markdown } from './Markdown.tsx';
import { ToolBlock } from './ToolBlock.tsx';
import { Disclosure } from './Disclosure.tsx';
import { exactTime, clockTime } from './time.ts';
import type { Delta } from './liveMerge.ts';
import { Icon } from '../../Icon.tsx';
import { useReferences } from '../../state/references.ts';
import { useExperiments } from '../../state/experiments.ts';

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
  nodeId,
  messages,
  runs,
  pending,
  running,
  phase = 'working',
  onProjectSettings,
}: {
  /** The experiment this is, so a message saved as a reference records where it came from. */
  nodeId: string;
  messages: readonly MessageView[];
  runs: readonly RunView[];
  /** Live deltas the persisted transcript has not caught up with. */
  pending: readonly Delta[];
  running: boolean;
  /** What the live run is doing: its turn, waiting for background work (D43), or compacting. */
  phase?: RunActivity['state'];
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
            nodeId={nodeId}
            group={group}
            run={runsById.get(group.runId)}
            number={numberOf.get(group.runId) ?? null}
            running={
              running &&
              (group.runId === liveRunId || runsById.get(group.runId)?.status === 'running')
            }
            phase={phase}
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
  nodeId,
  group,
  run,
  number,
  running,
  phase,
}: {
  nodeId: string;
  group: Group;
  run: RunView | undefined;
  number: number | null;
  running: boolean;
  phase: RunActivity['state'];
}): JSX.Element {
  const { prompt, rest } = splitPrompt(group.messages);
  const parts = compose(rest);
  // Notes from Bonsai (a compaction, a skipped command) are not the agent speaking.
  const agentSpoke = parts.some((part) => part.kind !== 'said' || part.message.role !== 'system');
  const when = prompt?.createdAt ?? run?.startedAt ?? null;
  const sent: Sent = {
    references: run?.resolvedContext?.references ?? [],
    experiments: run?.resolvedContext?.experiments ?? [],
  };
  // A finished message can be saved as it stands; a live one is still changing.
  const saveFrom = running ? null : nodeId;
  const reply = saveFrom === null ? null : finalReply(parts);

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

      {prompt !== undefined && (
        <YouSaid
          message={prompt}
          saveFrom={saveFrom}
          sent={group.runId === null ? undefined : { runId: group.runId, ...sent }}
        />
      )}

      {(parts.length > 0 || running) && (
        <div className="msg agent">
          {(agentSpoke || running) && (
            <div className="msg-head">
              <span className="msg-label">Agent:</span>
              {reply !== null && saveFrom !== null && (
                <SaveAsReference
                  text={reply}
                  nodeId={saveFrom}
                  label="Save the final reply as a reference"
                />
              )}
            </div>
          )}
          {parts.map((part, i) =>
            part.kind === 'block' ? (
              <ToolBlock
                key={i}
                name={part.name}
                detail={part.detail}
                subject={attachmentRead(part.name, part.detail, sent)}
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
              {LIVE_WORDS[phase]}&hellip;
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
            <dt>Parent</dt>
            <dd>{run.resolvedContext.parentName ?? 'None'}</dd>
            <dt>Resolved</dt>
            <dd>{run.resolvedContext.resolvedAt}</dd>
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
  saveFrom = null,
  sent,
}: {
  message: MessageView;
  inline?: boolean;
  /** The experiment to record as the source when this is saved as a reference. */
  saveFrom?: string | null;
  /** What the run this message started was given alongside it. */
  sent?: (Sent & { runId: string }) | undefined;
}): JSX.Element {
  const text = asText(message.content);
  return (
    <div className={`msg you${inline ? ' inline' : ''}`}>
      <div className="msg-head">
        <span className="msg-label">You:</span>
        {saveFrom !== null && (
          <SaveAsReference text={text} nodeId={saveFrom} label="Save this message as a reference" />
        )}
      </div>
      <Clamped text={text} />
      {sent !== undefined && sent.references.length + sent.experiments.length > 0 && (
        <SentWith {...sent} />
      )}
    </div>
  );
}

/**
 * Keep a message for other experiments: opens the reference editor with the
 * text exactly as it is. Nothing is summarised and nothing is saved until the
 * editor is.
 */
function SaveAsReference({
  text,
  nodeId,
  label,
}: {
  text: string;
  nodeId: string;
  label: string;
}): JSX.Element {
  const { open } = useReferences();
  return (
    <button
      className="save-reference"
      aria-label={label}
      title={label}
      onClick={() => open({ kind: 'new', content: text, sourceNodeId: nodeId })}
    >
      <Icon name="reference" />
      <span>Save as reference</span>
    </button>
  );
}

/** What a run received alongside its message, as recorded when it started. */
interface Sent {
  references: readonly RunReferenceView[];
  experiments: readonly RunExperimentView[];
}

/**
 * What a message went with, as that run received it. A chip says when the
 * reference or experiment has changed or gone since. A reference opens the
 * exact copy the run read; an experiment opens the experiment itself.
 */
function SentWith({ runId, references, experiments }: Sent & { runId: string }): JSX.Element {
  const library = useReferences();
  const tree = useExperiments();
  const chips = [
    ...references.map((reference) => {
      const now = library.byId.get(reference.id);
      return {
        key: `reference:${reference.id}`,
        kind: 'reference' as const,
        name: reference.name,
        state:
          now === undefined
            ? 'deleted'
            : now.revision === reference.revision
              ? null
              : 'edited since',
        title: 'Show exactly what this run was given',
        open: () => library.open({ kind: 'snapshot', runId, reference }),
      };
    }),
    ...experiments.map((experiment) => {
      const now = tree.byId.get(experiment.id);
      return {
        key: `experiment:${experiment.id}`,
        kind: 'experiment' as const,
        name: experiment.name,
        state:
          now === undefined ? 'deleted' : now.runCount === experiment.runs ? null : 'changed since',
        title:
          now === undefined
            ? 'This experiment has been deleted'
            : `Go to ${now.displayName}. This run read it as it was then.`,
        open: now === undefined ? undefined : () => tree.open(now.id),
      };
    }),
  ];
  return (
    <ul className="sent-references" aria-label="Sent with this message">
      {chips.map((chip) => (
        <li key={chip.key}>
          <button
            className={`reference-chip sent kind-${chip.kind}${chip.state === null ? '' : ' changed'}`}
            title={chip.title}
            disabled={chip.open === undefined}
            onClick={chip.open}
          >
            <Icon name={chip.kind} />@{chip.name}
            {chip.state !== null && <small>{chip.state}</small>}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The agent's final reply: what it said after its last tool call, or its last
 * words if it said nothing after. The narration between calls ("let me look at
 * the tests") is how it got there, not what it found.
 */
function finalReply(parts: readonly Part[]): string | null {
  const said = (part: Part): part is Extract<Part, { kind: 'said' }> =>
    part.kind === 'said' &&
    part.message.role === 'assistant' &&
    !isCompaction(part.message.content);
  let lastBlock = -1;
  parts.forEach((part, i) => {
    if (part.kind === 'block') lastBlock = i;
  });
  const after = parts.slice(lastBlock + 1).filter(said);
  const chosen = after.length > 0 ? after : parts.filter(said).slice(-1);
  const text = chosen
    .map((part) => asText(part.message.content).trim())
    .filter((t) => t !== '')
    .join('\n\n');
  return text === '' ? null : text;
}

/** What each file in an experiment's snapshot is, in a word. */
const EXPERIMENT_FILE_WORDS: Record<string, string> = {
  'conversation.md': 'conversation',
  'changes.diff': 'changes',
  'CONTEXT.md': 'notes',
};

/**
 * A Read of something the run was given, named as what it is rather than its
 * file path: `@smoke-test`, or `@try-redis · changes`.
 */
function attachmentRead(name: string, detail: string, sent: Sent): string | undefined {
  if (name !== 'Read') return undefined;
  const parts = detail.split(/[\\/]/);
  const at = parts.lastIndexOf('run-context');
  if (at === -1) return undefined;
  const [, kind, item, file] = parts.slice(at + 1);
  if (kind === 'references' && item !== undefined) {
    const reference = sent.references.find((r) => r.file === item);
    return reference === undefined ? undefined : `@${reference.name}`;
  }
  if (kind === 'experiments' && item !== undefined) {
    const experiment = sent.experiments.find((e) => e.folder === item);
    if (experiment === undefined) return undefined;
    const word = file === undefined ? undefined : EXPERIMENT_FILE_WORDS[file];
    return `@${experiment.name}${word === undefined ? '' : ` · ${word}`}`;
  }
  return undefined;
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

const LIVE_WORDS: Record<RunActivity['state'], string> = {
  working: 'working',
  waiting: 'waiting for background work',
  compacting: 'compacting conversation',
};

/** Anything said without a box: the agent's prose, or a note from Bonsai. */
function Said({ message }: { message: MessageView }): JSX.Element {
  if (isCompaction(message.content)) return <CompactionDivider note={message.content} />;
  const text = asText(message.content);
  if (message.role === 'system') return <p className="msg system">{text}</p>;
  return <Markdown source={text} />;
}

/**
 * Where older turns were replaced by a summary. A rule across the thread,
 * because everything above it is what the agent no longer holds word for word.
 */
function CompactionDivider({ note }: { note: CompactionNote }): JSX.Element {
  const { trigger, tokensBefore, tokensAfter } = note.compaction;
  return (
    <div
      className="compaction-divider"
      role="note"
      title="Earlier turns were replaced by a summary to free context. They are still shown here; the agent keeps the summary."
    >
      <span className="compaction-rule" />
      <span className="compaction-label">
        Conversation compacted{trigger === 'auto' ? ' automatically' : ''} ·{' '}
        {tokenCount(tokensBefore)}
        {tokensAfter === null ? '' : ` → ${tokenCount(tokensAfter)}`} tokens
      </span>
      <span className="compaction-rule" />
    </div>
  );
}

function isCompaction(content: unknown): content is CompactionNote {
  return typeof content === 'object' && content !== null && 'compaction' in content;
}

/** 48200 → "48k", 950 → "950". */
function tokenCount(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
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
