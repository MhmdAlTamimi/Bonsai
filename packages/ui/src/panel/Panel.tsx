import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import type { NodeDetail, NodeView, ProjectView, RunActivity, RunView } from '@bonsai/shared';

import { NextRunInfo } from './NextRunInfo.tsx';
import { Icon } from '../Icon.tsx';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import { ExperimentChanges } from './node/ExperimentChanges.tsx';
import { Checks } from './node/Checks.tsx';
import { RenameDialog } from './node/RenameDialog.tsx';
import { Checkout } from './node/Checkout.tsx';
import { Details } from './node/Details.tsx';
import { Lineage } from './node/Lineage.tsx';
import { Recovery } from './node/Recovery.tsx';
import { useNodeActions } from './node/useNodeActions.ts';
import { STATUS_LABEL, nodeStatusTitle } from '../nodeStatus.tsx';
import { AskBox } from './node/AskBox.tsx';
import { ActivityStrip } from './chat/ActivityStrip.tsx';
import { Composer } from './chat/Composer.tsx';
import { Transcript } from './chat/Transcript.tsx';
import { useReadingPosition } from './chat/useReadingPosition.ts';
import { useChat } from './chat/useChat.ts';
import type { Delta } from './chat/liveMerge.ts';
import { useDismiss } from '../useDismiss.ts';

/** One selected experiment: fixed identity/actions, reading area, and composer. */
export function Panel({
  project,
  node,
  stream,
  liveActivity,
  streamRevision,
  onProjectSettings,
  onHide,
  onChanged,
  onCreateChild,
  startError,
  onRunStarted,
  visible,
  narrow,
}: {
  /** Needed only to explain why an adopted project's master cannot be written. */
  project: ProjectView | null;
  node: NodeView | null;
  stream: readonly Delta[];
  /** The newest pushed activity for this node, fresher than the tree's copy. */
  liveActivity: RunActivity | null;
  streamRevision: number;
  onProjectSettings: () => void;
  onHide: () => void;
  onChanged: () => void;
  /** Opens the one create-a-child dialog. See NewChildDialog. */
  onCreateChild: (node: NodeView) => void;
  startError: string | null;
  onRunStarted: () => void;
  /**
   * Whether the panel is on screen. It stays MOUNTED when it is not, so drafts
   * and loaded history survive -- but a hidden element has no layout box, and a
   * scroll position does not survive losing one. The reading position needs to
   * know to restore itself when the panel comes back.
   */
  visible: boolean;
  /** On a narrow window this is the whole screen, so closing it means "show the map". */
  narrow: boolean;
}): JSX.Element {
  if (node === null) {
    return (
      <aside className="panel empty">
        <p className="muted">Select an experiment to see its conversation.</p>
        <p className="hint">
          Click an experiment&rsquo;s + on the map to branch a new one, or drag it out to place it.
        </p>
      </aside>
    );
  }
  // Loaded data and actions remount with their owner; drafts live in a session map.
  return (
    <NodePanel
      key={`${project?.id}:${node.id}`}
      project={project}
      node={node}
      stream={stream}
      liveActivity={liveActivity}
      streamRevision={streamRevision}
      onHide={onHide}
      visible={visible}
      narrow={narrow}
      onProjectSettings={onProjectSettings}
      onChanged={onChanged}
      onCreateChild={onCreateChild}
      startError={startError}
      onRunStarted={onRunStarted}
    />
  );
}

function NodePanel({
  project,
  node,
  stream,
  liveActivity,
  streamRevision,
  onProjectSettings,
  onHide,
  onChanged,
  onCreateChild,
  startError,
  onRunStarted,
  visible,
  narrow,
}: {
  project: ProjectView | null;
  node: NodeView;
  stream: readonly Delta[];
  liveActivity: RunActivity | null;
  streamRevision: number;
  onProjectSettings: () => void;
  onHide: () => void;
  onChanged: () => void;
  onCreateChild: (node: NodeView) => void;
  startError: string | null;
  onRunStarted: () => void;
  visible: boolean;
  narrow: boolean;
}): JSX.Element {
  const [renaming, setRenaming] = useState(false);
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const changed = (): void => {
    if (!mounted.current) return;
    setRevision((n) => n + 1);
    onChanged();
  };
  const [error, setError] = useState<string | null>(null);
  const actions = useNodeActions(node, changed, setError);
  const chat = useChat(
    node,
    stream,
    streamRevision,
    () => {
      changed();
      onRunStarted();
    },
    setError,
  );

  useEffect(() => {
    setDetailError(null);
    let alive = true;
    const controller = new AbortController();
    void api
      .node(node.id, controller.signal)
      .then((d) => alive && setDetail(d))
      .catch((e: unknown) => alive && setDetailError(describeError(e)));
    return () => {
      alive = false;
      controller.abort();
    };
    // Deliberately not `[node]`. A refetch hands back a new object every time,
    // so depending on it would refetch the detail in a loop; the id and the
    // status are the only parts this effect actually reads.
  }, [node.id, node.status, revision, streamRevision]);

  const runs = detail?.runs ?? [];
  // Only a running node is doing anything. A pushed value can outlive its run
  // by a moment, and the tree's copy by a refetch.
  const activity = node.status === 'running' ? (liveActivity ?? node.activity) : null;
  const reading = useReadingPosition(
    `${node.projectId}:${node.id}`,
    chat.loaded && detail !== null,
    // A hidden panel has no layout box, and a scroll position does not survive
    // losing one, so the thread restores itself when it comes back.
    visible,
    `${chat.messages.length}:${chat.pending.length}:${streamRevision}`,
  );

  /**
   * Master of an adopted project: its worktree is the user's own folder, on the
   * branch they work on. Bonsai will not write there, which is why the node is
   * read-only from the start rather than after a child commits.
   */
  const isYourFolder = node.frozenReason === 'your_folder';

  const source = detail?.lineage.codeFrom?.displayName ?? null;

  return (
    <aside className="panel">
      {/*
       * Identity on the right, controls on the left: the name is what you
       * read, and it sits against the edge the panel is docked to, so the eye
       * finds it in the same place whatever the width.
       */}
      <header className="panel-head">
        <button
          className="collapse"
          aria-label={narrow ? 'Back to map' : 'Collapse the conversation'}
          title={narrow ? 'Back to map' : 'Collapse the conversation (⌘\\)'}
          onClick={onHide}
        >
          <span aria-hidden="true">›</span>
          <span className="collapse-bar" aria-hidden="true" />
        </button>
        <OverflowMenu
          busy={actions.busy}
          onBranch={() => onCreateChild(node)}
          onRename={() => setRenaming(true)}
          onDelete={node.parentId === null ? undefined : () => void actions.remove()}
        />
        <div className="spacer" />
        <span
          className={`node-dot st-${node.status}`}
          title={nodeStatusTitle(node)}
          aria-label={STATUS_LABEL[node.status]}
        />
        <h2 title={node.displayName}>{node.displayName}</h2>
        <span className="run-count">
          {runs.length} run{runs.length === 1 ? '' : 's'}
        </span>
      </header>

      <p className="panel-meta">
        {source !== null && (
          <>
            <span>from {source}</span>
            <span className="sep">·</span>
          </>
        )}
        {node.diffStat === null ? (
          <span className="no-change">no file changes</span>
        ) : (
          <>
            <span>
              {node.diffStat.files} file{node.diffStat.files === 1 ? '' : 's'}
            </span>
            <span className="added">+{node.diffStat.added.toLocaleString()}</span>
            {node.diffStat.removed > 0 && (
              <span className="removed">−{node.diffStat.removed.toLocaleString()}</span>
            )}
          </>
        )}
      </p>

      {isYourFolder && (
        <p className="note" title={project?.sourcePath ?? undefined}>
          Your own folder — read only. Branch a child to make changes.
        </p>
      )}
      {detail?.baseIsPinnedBehindLiveWalk === true && (
        <p
          className="note"
          title="Its base stays pinned where it was, so its code and its inherited conversation still describe the same tree."
        >
          An ancestor has committed since this node branched.
        </p>
      )}

      {/*
       * One scrolling region, anchored to the composer: the newest turn sits
       * just above the reply box, and a short thread leaves its space at the
       * top rather than floating above nothing.
       */}
      <div className="panel-body" ref={reading.scrollRef} onScroll={reading.onScroll}>
        <div ref={reading.contentRef} className="conversation-content">
          {node.status === 'new' && (
            <section className="start">
              <h3>Ready for the first run</h3>
              <p className="hint">
                Creating this experiment has not run the agent. Edit the request below, then choose
                Start first run.
              </p>
            </section>
          )}

          {(detail === null || detailError !== null) &&
            (detailError === null ? (
              <p role="status">Loading experiment details…</p>
            ) : (
              <p className="error" role="alert">
                {detailError}{' '}
                <button onClick={() => setRevision((n) => n + 1)}>Retry details</button>
              </p>
            ))}
          {chat.loading && !chat.loaded && <p role="status">Loading conversation…</p>}
          {chat.error !== null && (
            <p className="error" role="alert">
              {chat.loaded && 'Showing previously loaded conversation. '}
              {chat.error} <button onClick={chat.retry}>Retry conversation</button>
            </p>
          )}
          {chat.loaded &&
            chat.error === null &&
            chat.messages.length === 0 &&
            chat.pending.length === 0 &&
            !chat.busy && (
              <p className="muted chat-empty">
                No conversation yet. Ask for a change, or ask a question.
              </p>
            )}
          {(chat.messages.length > 0 || chat.pending.length > 0) && (
            <Transcript
              messages={chat.messages}
              runs={runs}
              pending={chat.pending}
              running={chat.running}
              waiting={activity?.state === 'waiting'}
              onProjectSettings={onProjectSettings}
            />
          )}

          {detail !== null && runs.length > 0 && (
            <ResultDetails
              node={node}
              detail={detail}
              runs={runs}
              activity={activity}
              isYourFolder={isYourFolder}
              revision={`${revision}:${runs.at(-1)?.id ?? ''}:${runs.at(-1)?.status ?? ''}`}
              onError={setError}
            />
          )}
        </div>
      </div>

      <div className="panel-foot">
        {reading.away && (
          <button className="jump-latest" onClick={reading.jump}>
            {reading.unread ? 'New output · Jump to latest' : 'Jump to latest'}
            <Icon name="arrowDown" />
          </button>
        )}
        {(node.status === 'interrupted' || (detail?.partialWork?.changed.length ?? 0) > 0) &&
          node.status !== 'running' &&
          node.status !== 'needs_you' && (
            <Recovery
              node={node}
              runs={runs}
              isYourFolder={isYourFolder}
              busy={actions.busy}
              partialWork={detail?.partialWork ?? null}
              onRecover={(action) => void actions.recover(action)}
            />
          )}
        {!chat.busy && detail?.nextRunSettings && (
          <NextRunInfo value={detail.nextRunSettings} onSettings={onProjectSettings} />
        )}
        {error !== null && (
          <p className="error" role="alert">
            {error} <button onClick={() => setError(null)}>Dismiss</button>
          </p>
        )}
        <ActivityStrip node={node} activity={activity} onError={setError} />
        {startError !== null && (
          <p className="error start-error" role="alert">
            {startError}
          </p>
        )}
        <AskBox
          key={node.pendingQuestion?.id}
          node={node}
          onAnswered={onChanged}
          onError={setError}
        />
        {node.pendingQuestion === null && (
          <Composer
            node={node}
            busy={chat.busy}
            sending={chat.sending}
            value={chat.prompt}
            onChange={chat.setPrompt}
            onSend={chat.send}
            onBranch={node.writable ? () => onCreateChild(node) : undefined}
          />
        )}
      </div>

      {renaming && (
        <RenameDialog node={node} onClose={() => setRenaming(false)} onChanged={changed} />
      )}
      {actions.confirmDialog}
    </aside>
  );
}

/**
 * Everything about the result that is not the conversation: how the last run
 * ended, the checks, what it changed, where it came from, and how to open it
 * outside Bonsai.
 *
 * Closed until asked for, and at the end of the thread rather than above the
 * composer. All of it is reference -- true whether or not you are looking at
 * it -- and the panel is for reading the conversation.
 */
function ResultDetails({
  node,
  detail,
  runs,
  activity,
  isYourFolder,
  revision,
  onError,
}: {
  node: NodeView;
  detail: NodeDetail;
  runs: readonly RunView[];
  activity: RunActivity | null;
  isYourFolder: boolean;
  revision: string;
  onError: (message: string | null) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <details className="result-details" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Result details</summary>
      {open && (
        <>
          <p className="result-outcome">{latestRunOutcome(runs.at(-1), activity)}</p>
          <Checks node={node} detail={detail} />
          <ExperimentChanges node={node} revision={revision} />
          <Lineage lineage={detail.lineage} />
          <Details node={node} detail={detail} runs={runs} isYourFolder={isYourFolder} />
          {detail.checkoutCommand != null && runs.some((run) => run.commitSha !== null) && (
            <Checkout
              command={detail.checkoutCommand}
              hint={detail.checkoutHint}
              onError={onError}
            />
          )}
        </>
      )}
    </details>
  );
}

/** The latest run in one line, by why it ended (D45) -- or what it is doing. */
function latestRunOutcome(run: RunView | undefined, activity: RunActivity | null): string {
  if (run === undefined) return 'No runs recorded yet.';
  switch (run.endReason) {
    case 'finished':
      return `Finished — ${run.commitSha === null ? 'answered without file changes' : 'files changed'}.`;
    case 'stopped':
      return 'You stopped this run — review any uncommitted work.';
    case 'failed':
      return 'Failed — review the conversation and any uncommitted work.';
    case 'app_closed':
      return 'Bonsai closed while this run was working — review any uncommitted work.';
    case null:
      return activity?.state === 'waiting'
        ? 'Waiting for background work — results are saved when it ends.'
        : 'In progress — no completed result yet.';
  }
}

/**
 * Delete, out of thumb's reach.
 *
 * It used to be a lowercase link eight pixels from Stop: irreversible,
 * cascading to every descendant, and styled as the least prominent control in
 * the header -- so the confirmation existed to catch a misclick the layout was
 * inviting. Behind a menu it takes a deliberate second action to reach.
 */
function OverflowMenu({
  busy,
  onBranch,
  onDelete,
  onRename,
}: {
  busy: boolean;
  onBranch: () => void;
  onDelete?: () => void;
  onRename: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    useCallback(() => setOpen(false), []),
    ref,
    '.overflow',
  );

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button
        className="overflow"
        onClick={() => setOpen((v) => !v)}
        aria-label="More actions"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Icon name="more" />
      </button>
      {open && (
        <div
          className="menu-panel right"
          role="menu"
          onKeyDown={(event) => {
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
            );
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              items[
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? items.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
              ]?.focus();
            }
            if (event.key === 'Tab') setOpen(false);
          }}
        >
          {/*
           * Branching lives here and on the map's `+`, not as a full-width
           * button: it took a row of the panel for something done from the
           * map. The trigger takes focus first, so a dialog closed without
           * creating anything gives the keyboard back to this menu.
           */}
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              ref.current?.querySelector<HTMLButtonElement>('.overflow')?.focus();
              onBranch();
            }}
          >
            Branch experiment…
          </button>
          <button
            role="menuitem"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              onRename();
            }}
          >
            Rename experiment…
          </button>
          {onDelete !== undefined && (
            <button
              className="danger"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
            >
              Delete this experiment…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
