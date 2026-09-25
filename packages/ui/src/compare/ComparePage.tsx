import { type JSX, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ComparedExperimentView, ComparisonView } from '@bonsai/shared';

import { Icon } from '../Icon.tsx';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import type { ConfirmRequest } from '../ConfirmDialog.tsx';
import { STATUS_LABEL } from '../nodeStatus.tsx';
import { Transcript } from '../panel/chat/Transcript.tsx';
import { useCanRun } from '../state/RunAvailability.ts';
import {
  comparisonMessages,
  comparisonRuns,
  compareTone,
  useComparison,
} from '../state/compare.ts';
import { useReferences } from '../state/references.ts';
import { CompareComposer } from './CompareComposer.tsx';
import { CompareMenu } from './CompareMenu.tsx';

/**
 * A comparison: its experiments side by side, and a conversation about them
 * with an agent that can only read.
 *
 * A screen of its own, like Review, because comparing is the whole job while
 * you are doing it. The cards say what each experiment recorded, as of its
 * snapshot; the conversation is where you find out the rest. Nothing on this
 * screen can change an experiment -- it has no Run, Review or Commit, only
 * questions, and saving what you learn as a reference.
 */
export function ComparePage({
  comparisonId,
  projectId,
  revision,
  onBack,
  onOpenExperiment,
  ask,
}: {
  comparisonId: string;
  projectId: string;
  /**
   * Changes whenever a comparison or an experiment does -- the second so a card
   * can say its experiment has moved on since.
   */
  revision: string;
  onBack: () => void;
  onOpenExperiment: (nodeId: string) => void;
  ask: (request: ConfirmRequest) => Promise<boolean>;
}): JSX.Element {
  const { data, error } = useComparison(comparisonId, revision);
  const references = useReferences();
  const [actionError, setActionError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const running = data?.turns.at(-1)?.status === 'running';

  // Follow the answer while you are at the end of the conversation; leave you
  // where you are if you scrolled up to read.
  const count = data?.messages.length ?? 0;
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const element = body.current;
    if (element !== null && atEnd.current) element.scrollTop = element.scrollHeight;
  }, [count, running]);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setActionError(null);
    try {
      await action();
    } catch (e) {
      setActionError(describeError(e));
    }
  };
  /** Rejects when asking failed, so the composer keeps the question to try again. */
  const askQuestion = async (prompt: string): Promise<void> => {
    setActionError(null);
    atEnd.current = true;
    try {
      await api.askComparison(comparisonId, prompt);
    } catch (e) {
      setActionError(describeError(e));
      throw e;
    }
  };
  const update = async (): Promise<void> => {
    setUpdating(true);
    await run(() => api.refreshComparison(comparisonId));
    setUpdating(false);
  };

  /**
   * Escape goes back to the map, as it does from Review -- never while typing,
   * and never while a dialog (a reference being saved, a confirmation) has it.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as HTMLElement | null)?.closest('input, textarea, select')) return;
      if (document.querySelector('dialog[open]') !== null) return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const stale = data?.experiments.filter((e) => e.newRuns > 0) ?? [];
  return (
    <section className="compare" aria-label="Compare experiments">
      <header className="review-bar compare-head">
        <button className="back" onClick={onBack} title="Back to the map (Esc)">
          <span aria-hidden="true">←</span>
          <span>Back to canvas</span>
          <span className="keycap" aria-hidden="true">
            Esc
          </span>
        </button>
        <span className="bar-divider" aria-hidden="true" />
        <Icon name="compare" />
        {data === null ? (
          <h1>Comparison</h1>
        ) : (
          <Title
            key={data.title}
            title={data.title}
            onRename={(title) => run(() => api.renameComparison(comparisonId, title))}
          />
        )}
        <div className="spacer" />
        {data !== null && (
          <>
            <button
              className="icon-only compare-save"
              aria-label="Save this comparison as a reference"
              title="Save this comparison as a reference"
              disabled={data.turns.length === 0}
              onClick={() =>
                references.open({
                  kind: 'new',
                  draft: true,
                  comparison: { id: data.id, title: data.title },
                })
              }
            >
              <Icon name="reference" />
            </button>
            <CompareMenu
              onDelete={() =>
                void ask({
                  title: 'Delete this comparison?',
                  body: [
                    `“${data.title}” and its conversation will be removed. The experiments are not touched, and references saved from it are kept.`,
                  ],
                  confirmLabel: 'Delete comparison',
                  danger: true,
                }).then((ok) => {
                  if (ok) void run(() => api.deleteComparison(comparisonId).then(onBack));
                })
              }
            />
          </>
        )}
      </header>

      <div
        className="compare-body"
        ref={body}
        onScroll={(e) => {
          const element = e.currentTarget;
          atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
        }}
      >
        {data === null ? (
          <p className={error === null ? 'muted compare-loading' : 'error'} role="status">
            {error ?? 'Loading the comparison…'}
          </p>
        ) : (
          <>
            {stale.length > 0 && (
              <div className="compare-stale" role="status">
                <span>
                  {stale
                    .map((e) => `${e.name} has ${e.newRuns} new run${e.newRuns === 1 ? '' : 's'}`)
                    .join(' · ')}{' '}
                  since this comparison.
                </span>
                <button disabled={updating || running} onClick={() => void update()}>
                  {updating ? 'Updating…' : 'Update comparison'}
                </button>
              </div>
            )}
            <ol className={`compare-cards count-${data.experiments.length}`}>
              {data.experiments.map((experiment, position) => (
                <ExperimentCard
                  key={position}
                  experiment={experiment}
                  position={position}
                  onOpen={onOpenExperiment}
                />
              ))}
            </ol>
            <div className="compare-thread thread-width">
              <Intro
                view={data}
                disabled={running}
                onAsk={(prompt) => void askQuestion(prompt).catch(() => undefined)}
              />
              {data.messages.length > 0 && (
                <Transcript
                  onSave={(text) =>
                    references.open({
                      kind: 'new',
                      content: text,
                      comparison: { id: data.id, title: data.title },
                    })
                  }
                  messages={comparisonMessages(data)}
                  runs={comparisonRuns(data)}
                  pending={[]}
                  running={running}
                />
              )}
            </div>
          </>
        )}
      </div>

      <div className="compare-foot thread-width">
        {actionError !== null && (
          <p className="error" role="alert">
            {actionError} <button onClick={() => setActionError(null)}>Dismiss</button>
          </p>
        )}
        <CompareComposer
          projectId={projectId}
          comparisonId={comparisonId}
          running={running}
          disabled={data === null}
          onAsk={askQuestion}
          onStop={() => void run(() => api.stopComparison(comparisonId))}
        />
      </div>
    </section>
  );
}

/** Questions that show what the page is for; one click asks. */
const SUGGESTIONS = [
  'Compare their results',
  'How do their approaches differ?',
  'What did each one test, and what did it show?',
  'Which should I continue, and why?',
  'Draft a plan that combines what worked',
];

/**
 * The agent's opening, always first: what it has read and what it can and
 * cannot do. Written by Bonsai rather than the model -- it is a fact about the
 * comparison, and it costs nothing -- but said in the agent's voice, where the
 * answers will be.
 */
function Intro({
  view,
  disabled,
  onAsk,
}: {
  view: ComparisonView;
  disabled: boolean;
  onAsk: (prompt: string) => void;
}): JSX.Element {
  const canRun = useCanRun();
  return (
    <div className="msg agent compare-intro">
      <div className="msg-head">
        <span className="msg-label">Agent:</span>
      </div>
      <p>
        I have the context of{' '}
        {view.experiments.map((experiment, position) => (
          <span key={position}>
            {position > 0 && (position === view.experiments.length - 1 ? ' and ' : ', ')}
            <strong className={`compare-name ${compareTone(position)}`}>{experiment.name}</strong>
          </span>
        ))}
        : each one&rsquo;s conversation, everything it committed, its notes, and its files as of
        this comparison.
      </p>
      <p>
        Ask me to compare them &mdash; results, approaches, trade-offs, what each tested and what
        didn&rsquo;t work &mdash; or to draft a plan from what they found. I only read: I
        can&rsquo;t run anything or change any of them.
      </p>
      {view.turns.length === 0 && (
        <div className="compare-suggestions" aria-label="Suggested questions">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              disabled={disabled || !canRun}
              onClick={() => onAsk(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One experiment as of its snapshot: what it set out to do, what it recorded
 * as tested, how it went about it and what it changed. Missing things are
 * said, not hidden -- "nothing recorded" is itself worth knowing.
 */
function ExperimentCard({
  experiment,
  position,
  onOpen,
}: {
  experiment: ComparedExperimentView;
  position: number;
  onOpen: (nodeId: string) => void;
}): JSX.Element {
  const { facts } = experiment;
  const missing = (text: string): JSX.Element => <span className="muted">{text}</span>;
  return (
    <li className={`compare-card ${compareTone(position)}`}>
      <header>
        <span className="pick-number" aria-hidden="true">
          {position + 1}
        </span>
        <h2 title={experiment.name}>{experiment.name}</h2>
        <span className={`status-dot st-${facts.status}`} aria-hidden="true" />
        <span className="compare-card-status">{STATUS_LABEL[facts.status]}</span>
        {experiment.nodeId !== null && (
          <button
            className="icon-only"
            aria-label={`Open ${experiment.name}`}
            title="Open this experiment"
            onClick={() => onOpen(experiment.nodeId!)}
          >
            <Icon name="arrowRight" />
          </button>
        )}
      </header>
      {experiment.nodeId === null && (
        <p className="compare-card-note">Deleted since. This is how it was.</p>
      )}
      <dl>
        <dt>Goal</dt>
        <dd>{facts.successCriteria ?? missing('Not stated')}</dd>
        <dt>Tested</dt>
        <dd className="clamp" title={facts.testing ?? undefined}>
          {facts.testing === null ? missing('Nothing recorded') : plain(facts.testing)}
        </dd>
        <dt>Approach</dt>
        <dd className="clamp" title={facts.approach ?? undefined}>
          {facts.approach ?? missing('No notes')}
        </dd>
        <dt>Changed</dt>
        <dd title={facts.files.join('\n')}>
          {facts.files.length === 0 ? (
            missing('Nothing committed')
          ) : (
            <>
              {facts.files.length} file{facts.files.length === 1 ? '' : 's'}{' '}
              <span className="tool-tally added">+{facts.added}</span>{' '}
              <span className="tool-tally removed">−{facts.removed}</span>
              <small className="compare-files">
                {facts.files
                  .slice(0, 3)
                  .map((file) => file.split('/').at(-1))
                  .join(', ')}
                {facts.files.length > 3 ? ` +${facts.files.length - 3}` : ''}
              </small>
            </>
          )}
        </dd>
      </dl>
      <footer>
        {facts.runs} run{facts.runs === 1 ? '' : 's'} · ${facts.costUsd.toFixed(2)}
        {experiment.newRuns > 0 && (
          <span className="compare-card-new">{experiment.newRuns} new since</span>
        )}
      </footer>
    </li>
  );
}

/** A heading and list markers out of recorded notes, which a card shows as text. */
function plain(markdown: string): string {
  return markdown
    .split('\n')
    .filter((line) => !/^#{1,6}\s/.test(line))
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter((line) => line !== '')
    .join(' · ');
}

/** The comparison's name, renamed in place: click it, type, Enter. */
function Title({
  title,
  onRename,
}: {
  title: string;
  onRename: (title: string) => Promise<void>;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const field = useRef<HTMLInputElement>(null);
  // The field replaced the heading that was clicked, so it takes the focus.
  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);
  if (!editing) {
    return (
      <h1>
        <button
          className="compare-title"
          title="Rename this comparison"
          onClick={() => setEditing(true)}
        >
          {title}
        </button>
      </h1>
    );
  }
  const save = (): void => {
    setEditing(false);
    if (value.trim() !== '' && value.trim() !== title) void onRename(value.trim());
    else setValue(title);
  };
  return (
    <input
      className="compare-title-input"
      aria-label="comparison name"
      value={value}
      maxLength={120}
      ref={field}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) save();
        if (e.key === 'Escape') {
          e.stopPropagation();
          setValue(title);
          setEditing(false);
        }
      }}
    />
  );
}
