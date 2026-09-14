import { type JSX, useEffect, useRef, useState } from 'react';
import type { NodeDetail, NodeView, ProjectView } from '@bonsai/shared';

import { NextRunInfo } from './NextRunInfo.tsx';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import { ExperimentChanges } from './node/ExperimentChanges.tsx';
import { Checks } from './node/Checks.tsx';
import { RenameDialog } from './node/RenameDialog.tsx';
import { Checkout } from './node/Checkout.tsx';
import { Details } from './node/Details.tsx';
import { Lineage } from './node/Lineage.tsx';
import { Recover } from './node/Recover.tsx';
import { useNodeActions } from './node/useNodeActions.ts';
import { StatusChip } from '../nodeStatus.tsx';
import { AskBox } from './node/AskBox.tsx';
import { Composer } from './chat/Composer.tsx';
import { Transcript } from './chat/Transcript.tsx';
import { StopButton } from '../state/RunControls.tsx';
import { useReadingPosition } from './chat/useReadingPosition.ts';
import { useChat } from './chat/useChat.ts';
import type { Delta } from './chat/liveMerge.ts';

/** One selected experiment: fixed identity/actions, reading area, and composer. */
export function Panel({
  project,
  node,
  stream,
  streamRevision,
  onProjectSettings,
  onChanged,
  onCreateChild,
  startError,
  onRunStarted,
}: {
  /** Needed only to explain why an adopted project's master cannot be written. */
  project: ProjectView | null;
  node: NodeView | null;
  stream: readonly Delta[];
  streamRevision: number;
  onProjectSettings: () => void;
  onChanged: () => void;
  /** Opens the one create-a-child dialog. See NewChildDialog. */
  onCreateChild: (node: NodeView) => void;
  startError: string | null;
  onRunStarted: () => void;
}): JSX.Element {
  if (node === null) {
    return (
      <aside className="panel empty">
        <p className="muted">Select a node to see its conversation.</p>
        <p className="hint">Drag out of a node&rsquo;s handle to branch a new one.</p>
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
      streamRevision={streamRevision}
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
  streamRevision,
  onProjectSettings,
  onChanged,
  onCreateChild,
  startError,
  onRunStarted,
}: {
  project: ProjectView | null;
  node: NodeView;
  stream: readonly Delta[];
  streamRevision: number;
  onProjectSettings: () => void;
  onChanged: () => void;
  onCreateChild: (node: NodeView) => void;
  startError: string | null;
  onRunStarted: () => void;
}): JSX.Element {
  const [view, setView] = useState<'conversation' | 'results'>('conversation');
  const [resultsSeen, setResultsSeen] = useState(false);
  const changeView = (next: 'conversation' | 'results'): void => {
    setView(next);
    if (next === 'results') setResultsSeen(true);
  };
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
  const reading = useReadingPosition(
    `${node.projectId}:${node.id}`,
    chat.loaded && detail !== null,
    view === 'conversation',
    `${chat.messages.length}:${chat.pending.length}:${streamRevision}`,
  );

  /**
   * Master of an adopted project: its worktree is the user's own folder, on the
   * branch they work on. Bonsai will not write there, which is why the node is
   * read-only from the start rather than after a child commits.
   */
  const isYourFolder = node.frozenReason === 'your_folder';

  const branchButton = (
    <button className="branch-child" onClick={() => onCreateChild(node)}>
      <span aria-hidden="true">+</span> Branch experiment
    </button>
  );

  return (
    <aside className="panel">
      <header>
        <h2 title={node.displayName}>{node.displayName}</h2>
        <div className="header-right">
          {/* A node parked on a question is still holding an agent and a
              concurrency slot, so it needs the same way out as a running one. */}
          <StopButton node={node} />
          <StatusChip
            status={node.status}
            queuePosition={node.queuePosition}
            lastRunStatus={node.lastRunStatus}
          />
          <OverflowMenu
            busy={actions.busy}
            onRename={() => setRenaming(true)}
            onDelete={node.parentId === null ? undefined : () => void actions.remove()}
          />
        </div>
      </header>

      <div className="panel-actions">{branchButton}</div>

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
          <Recover
            runs={runs}
            isYourFolder={isYourFolder}
            busy={actions.busy}
            partialWork={detail?.partialWork ?? null}
            interrupted={node.status === 'interrupted'}
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
        {(['conversation', 'results'] as const).map((tab, index) => (
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
                const next =
                  e.key === 'Home'
                    ? 'conversation'
                    : e.key === 'End'
                      ? 'results'
                      : index === 0
                        ? 'results'
                        : 'conversation';
                changeView(next);
                document.getElementById(`tab-${node.id}-${next}`)?.focus();
              }
            }}
          >
            {tab === 'conversation' ? 'Conversation' : 'Results & changes'}
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
              onProjectSettings={onProjectSettings}
            />
          )}
        </div>
      </div>

      <div
        className="panel-body results-panel"
        hidden={view !== 'results'}
        role="tabpanel"
        id={`view-${node.id}-results`}
        aria-labelledby={`tab-${node.id}-results`}
      >
        {resultsSeen && (
          <>
            {detailError !== null && detail !== null && (
              <p className="error" role="alert">
                Results may be out of date. {detailError}{' '}
                <button onClick={() => setRevision((n) => n + 1)}>Retry results</button>
              </p>
            )}
            {detail === null ? (
              detailError === null ? (
                <p role="status">Loading results…</p>
              ) : (
                <p className="error" role="alert">
                  {detailError}{' '}
                  <button onClick={() => setRevision((n) => n + 1)}>Retry results</button>
                </p>
              )
            ) : (
              <>
                <section className="result-outcome">
                  <h3>Latest run</h3>
                  <p>
                    {runs.length === 0
                      ? 'No runs recorded yet.'
                      : runs.at(-1)?.status === 'done'
                        ? `Finished — ${runs.at(-1)?.commitSha === null ? 'answered without file changes' : 'files changed'}.`
                        : runs.at(-1)?.status === 'cancelled'
                          ? 'Cancelled — review any partial work.'
                          : runs.at(-1)?.status === 'failed'
                            ? 'Failed — review the conversation and partial work.'
                            : 'In progress — no completed result yet.'}
                  </p>
                </section>
                <Checks node={node} detail={detail} />
                <Lineage lineage={detail.lineage} />
              </>
            )}
            <ExperimentChanges
              node={node}
              revision={`${revision}:${runs.at(-1)?.id ?? ''}:${runs.at(-1)?.status ?? ''}`}
            />
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
            {reading.unread ? 'New output · Jump to latest ↓' : 'Jump to latest ↓'}
          </button>
        )}
        {error !== null && (
          <p className="error" role="alert">
            {error} <button onClick={() => setError(null)}>Dismiss</button>
          </p>
        )}
        {node.status === 'running' && (
          <p className="activity" role="status">
            {node.queuePosition !== null
              ? `Queued · position ${node.queuePosition}`
              : 'Agent working…'}
          </p>
        )}
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
  onDelete,
  onRename,
}: {
  busy: boolean;
  onDelete?: () => void;
  onRename: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
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
        ⋯
      </button>
      {open && (
        <div className="menu-panel right" role="menu">
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
