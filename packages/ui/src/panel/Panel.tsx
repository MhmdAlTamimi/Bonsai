import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChangedFile,
  ChangeScope,
  NodeDetail,
  NodeView,
  ProjectView,
  RunActivity,
  RunView,
} from '@bonsai/shared';

import { NextRunInfo } from './NextRunInfo.tsx';
import { Icon } from '../Icon.tsx';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import { ChangesTab } from './changes/ChangesTab.tsx';
import {
  changesMayHaveChanged,
  sameScope,
  scopeLabel,
  useChangeRevision,
} from './changes/useChanges.ts';
import { useWindows, windowsKey } from '../state/useWindows.ts';
import { openWindow } from '../state/windows.ts';
import { Checks } from './node/Checks.tsx';
import { RenameDialog } from './node/RenameDialog.tsx';
import { Checkout } from './node/Checkout.tsx';
import { Details } from './node/Details.tsx';
import { Lineage } from './node/Lineage.tsx';
import { Recovery } from './node/Recovery.tsx';
import { useNodeActions } from './node/useNodeActions.ts';
import { StatusChip } from '../nodeStatus.tsx';
import { AskBox } from './node/AskBox.tsx';
import { ActivityStrip } from './chat/ActivityStrip.tsx';
import { Composer } from './chat/Composer.tsx';
import { Transcript } from './chat/Transcript.tsx';
import { StopButton } from '../state/RunControls.tsx';
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
  const [view, setView] = useState<PanelView>('conversation');
  // A tab is mounted the first time it is shown and then kept, so switching
  // back does not refetch or lose a scroll position.
  const [seen, setSeen] = useState<ReadonlySet<PanelView>>(() => new Set(['conversation']));
  const changeView = (next: PanelView): void => {
    setView(next);
    setSeen((prev) => (prev.has(next) ? prev : new Set([...prev, next])));
  };
  const [changesScope, setChangesScope] = useState<ChangeScope>({ kind: 'all' });
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
    // Recovery can discard or keep files without the node's status saying so.
    changesMayHaveChanged();
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
  const changeRevision = useChangeRevision(node);
  const { windows, change: changeWindows } = useWindows(windowsKey(node.projectId, node.id));
  const openFile = (file: ChangedFile): void =>
    changeWindows((state, area) =>
      openWindow(
        state,
        { path: file.path, scope: changesScope, scopeLabel: scopeLabel(changesScope, runs) },
        area,
      ),
    );
  const openPaths = new Set(
    windows.list.filter((w) => sameScope(w.scope, changesScope)).map((w) => w.path),
  );
  const viewRunChanges = (runId: string): void => {
    setChangesScope({ kind: 'run', runId });
    changeView('changes');
  };
  // Only a running node is doing anything. A pushed value can outlive its run
  // by a moment, and the tree's copy by a refetch.
  const activity = node.status === 'running' ? (liveActivity ?? node.activity) : null;
  const reading = useReadingPosition(
    `${node.projectId}:${node.id}`,
    chat.loaded && detail !== null,
    // Both conditions, because both take the layout box away: the other tab is
    // showing, or the whole panel is off screen behind the map.
    visible && view === 'conversation',
    `${chat.messages.length}:${chat.pending.length}:${streamRevision}`,
  );

  /**
   * Master of an adopted project: its worktree is the user's own folder, on the
   * branch they work on. Bonsai will not write there, which is why the node is
   * read-only from the start rather than after a child commits.
   */
  const isYourFolder = node.frozenReason === 'your_folder';

  return (
    <aside className="panel">
      <header>
        <h2 title={node.displayName}>{node.displayName}</h2>
        <div className="header-right">
          <button
            className="hide-panel"
            aria-label={narrow ? 'Back to map' : 'Hide experiment panel'}
            title={narrow ? 'Back to map' : 'Hide this panel and show the whole map'}
            onClick={onHide}
          >
            <Icon name="close" />
          </button>
          {/* A node parked on a question is still holding an agent and a
              concurrency slot, so it needs the same way out as a running one. */}
          <StopButton node={node} />
          <StatusChip
            status={node.status}
            queuePosition={node.queuePosition}
            lastRunEndReason={node.lastRunEndReason}
            waiting={activity?.state === 'waiting'}
          />
          <OverflowMenu
            busy={actions.busy}
            onBranch={() => onCreateChild(node)}
            onRename={() => setRenaming(true)}
            onDelete={node.parentId === null ? undefined : () => void actions.remove()}
          />
        </div>
      </header>

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

      {/*
       * The one scrolling region. The transcript used to scroll inside this,
       * which scrolled inside the panel, so the wheel did different things two
       * centimetres apart. Everything that is read scrolls together; only the
       * composer is pinned, because a reply box you have to scroll to find is a
       * reply box you stop using.
       */}
      <div className="panel-tabs" role="tablist" aria-label="Experiment view">
        {PANEL_VIEWS.map((tab, index) => (
          <button
            key={tab}
            role="tab"
            id={`tab-${node.id}-${tab}`}
            aria-controls={`view-${node.id}-${tab}`}
            aria-selected={view === tab}
            tabIndex={view === tab ? 0 : -1}
            onClick={() => changeView(tab)}
            onKeyDown={(e) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                e.preventDefault();
                const last = PANEL_VIEWS.length - 1;
                const next =
                  PANEL_VIEWS[
                    e.key === 'Home'
                      ? 0
                      : e.key === 'End'
                        ? last
                        : (index + (e.key === 'ArrowRight' ? 1 : last)) % PANEL_VIEWS.length
                  ]!;
                changeView(next);
                document.getElementById(`tab-${node.id}-${next}`)?.focus();
              }
            }}
          >
            {tab === 'conversation'
              ? 'Conversation'
              : tab === 'changes'
                ? node.diffStat === null
                  ? 'Changes'
                  : `Changes (${node.diffStat.files})`
                : 'Summary'}
          </button>
        ))}
      </div>
      <div
        className="panel-body"
        ref={reading.scrollRef}
        onScroll={reading.onScroll}
        hidden={view !== 'conversation'}
        role="tabpanel"
        id={`view-${node.id}-conversation`}
        aria-labelledby={`tab-${node.id}-conversation`}
      >
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
              onViewRunChanges={viewRunChanges}
            />
          )}
        </div>
      </div>

      <div
        className="panel-body changes-panel"
        hidden={view !== 'changes'}
        role="tabpanel"
        id={`view-${node.id}-changes`}
        aria-labelledby={`tab-${node.id}-changes`}
      >
        {seen.has('changes') && (
          <ChangesTab
            node={node}
            runs={runs}
            scope={changesScope}
            revision={`${changeRevision}:${revision}:${runs.length}`}
            openPaths={openPaths}
            onScope={setChangesScope}
            onOpen={openFile}
          />
        )}
      </div>

      <div
        className="panel-body results-panel"
        hidden={view !== 'summary'}
        role="tabpanel"
        id={`view-${node.id}-summary`}
        aria-labelledby={`tab-${node.id}-summary`}
      >
        {seen.has('summary') && (
          <>
            {detailError !== null && detail !== null && (
              <p className="error" role="alert">
                Summary may be out of date. {detailError}{' '}
                <button onClick={() => setRevision((n) => n + 1)}>Retry summary</button>
              </p>
            )}
            {detail === null ? (
              detailError === null ? (
                <p role="status">Loading summary…</p>
              ) : (
                <p className="error" role="alert">
                  {detailError}{' '}
                  <button onClick={() => setRevision((n) => n + 1)}>Retry summary</button>
                </p>
              )
            ) : (
              <>
                <section className="result-outcome">
                  <h3>Latest run</h3>
                  <p>{latestRunOutcome(runs.at(-1), activity)}</p>
                </section>
                <Checks node={node} detail={detail} />
                <Lineage lineage={detail.lineage} />
              </>
            )}
            <Details node={node} detail={detail} runs={runs} isYourFolder={isYourFolder} />

            {detail?.checkoutCommand != null && runs.some((run) => run.commitSha !== null) && (
              <Checkout
                command={detail.checkoutCommand}
                hint={detail.checkoutHint}
                onError={setError}
              />
            )}
          </>
        )}
      </div>

      <div className="panel-foot">
        {!chat.busy && detail?.nextRunSettings && (
          <NextRunInfo value={detail.nextRunSettings} onSettings={onProjectSettings} />
        )}
        {view === 'conversation' && reading.away && (
          <button className="jump-latest" onClick={reading.jump}>
            {reading.unread ? 'New output · Jump to latest' : 'Jump to latest'}
            <Icon name="arrowDown" />
          </button>
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
            emphasised
            value={chat.prompt}
            onChange={chat.setPrompt}
            onSend={chat.send}
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

/** The panel's three views of one experiment. */
const PANEL_VIEWS = ['conversation', 'changes', 'summary'] as const;
type PanelView = (typeof PANEL_VIEWS)[number];

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
