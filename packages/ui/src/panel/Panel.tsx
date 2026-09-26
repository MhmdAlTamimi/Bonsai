import { type JSX, useEffect, useRef, useState } from 'react';
import type { NodeDetail, NodeView, ProjectView, RunActivity } from '@bonsai/shared';

import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import { ErrorNote } from '../ErrorNote.tsx';
import { Icon, IconButton } from '../Icon.tsx';
import { plural } from '../words.ts';
import { Recovery } from './node/Recovery.tsx';
import { useNodeActions } from './node/useNodeActions.ts';
import { nodeStatusTitle } from '../nodeStatus.tsx';
import { AskBox } from './node/AskBox.tsx';
import { ActivityStrip } from './chat/ActivityStrip.tsx';
import { Composer } from './chat/Composer.tsx';
import { RunFoot } from './chat/RunFoot.tsx';
import { Transcript } from './chat/Transcript.tsx';
import { useReadingPosition } from './chat/useReadingPosition.ts';
import { useChat } from './chat/useChat.ts';
import { useReferences } from '../state/references.ts';
import type { Delta } from './chat/liveMerge.ts';

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
  startError: string | null;
  onRunStarted: () => void;
  visible: boolean;
  narrow: boolean;
}): JSX.Element {
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
  const actions = useNodeActions(changed, setError);
  const references = useReferences();
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
  const latestRun = runs.at(-1);
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
  // A child that took no copy of its parent's conversation: started fresh, or
  // branched before the parent said anything.
  const freshConversation =
    detail !== null && detail.lineage.codeFrom !== null && detail.lineage.conversationFrom === null;

  return (
    <aside className="panel">
      {/*
       * Identity on the right, controls on the left: the name is what you
       * read, and it sits against the edge the panel is docked to, so the eye
       * finds it in the same place whatever the width.
       */}
      <header className="panel-head">
        <IconButton
          icon="chevronRight"
          className="collapse"
          label={narrow ? 'Back to map' : 'Collapse the conversation'}
          title={narrow ? 'Back to map' : 'Collapse the conversation (⌘\\)'}
          onClick={onHide}
        >
          <span className="collapse-bar" aria-hidden="true" />
        </IconButton>
        <div className="spacer" />
        <span className="node-dot" title={nodeStatusTitle(node)} aria-hidden="true" />
        <h2 title={node.displayName}>{node.displayName}</h2>
        <span className="run-count">{plural(runs.length, 'run')}</span>
      </header>

      <p className="panel-meta">
        {source !== null && (
          <>
            <span>from {source}</span>
            <span className="sep">·</span>
          </>
        )}
        {freshConversation && (
          <>
            <span title="Started without a copy of the parent's conversation. Its code is inherited.">
              fresh conversation
            </span>
            <span className="sep">·</span>
          </>
        )}
        {node.diffStat === null ? (
          <span className="no-change">no file changes</span>
        ) : (
          <>
            <span>{plural(node.diffStat.files, 'file')}</span>
            <span className="added">+{node.diffStat.added.toLocaleString()}</span>
            {node.diffStat.removed > 0 && (
              <span className="removed">−{node.diffStat.removed.toLocaleString()}</span>
            )}
          </>
        )}
      </p>

      {isYourFolder && (
        <p className="note" title={project?.sourcePath ?? undefined}>
          Your own folder — read only. Branch an experiment to make changes.
        </p>
      )}
      {detail?.baseIsPinnedBehindLiveWalk === true && (
        <p
          className="note"
          title="This experiment keeps the code snapshot and the conversation it was created with."
        >
          Parent code has moved ahead. This experiment keeps its pinned code snapshot.
        </p>
      )}

      {/*
       * One scrolling region, anchored to the composer: the newest turn sits
       * just above the reply box, and a short thread leaves its space at the
       * top rather than floating above nothing.
       */}
      <div className="panel-scroll">
        <div className="panel-body" ref={reading.scrollRef} onScroll={reading.onScroll}>
          <div ref={reading.contentRef} className="conversation-content">
            {node.status === 'new' && (
              <section className="start">
                <h3>Ready for the first run</h3>
                <p className="hint">
                  Creating this experiment has not run the agent. Edit the request below, then send
                  it to start the first run.
                </p>
              </section>
            )}

            {(detail === null || detailError !== null) &&
              (detailError === null ? (
                <p className="loading" role="status">
                  Loading experiment details
                </p>
              ) : (
                <ErrorNote onRetry={() => setRevision((n) => n + 1)} retryLabel="Retry details">
                  {detailError}
                </ErrorNote>
              ))}
            {chat.loading && !chat.loaded && (
              <p className="loading" role="status">
                Loading conversation
              </p>
            )}
            {chat.error !== null && (
              <ErrorNote onRetry={chat.retry} retryLabel="Retry conversation">
                {chat.loaded && 'Showing previously loaded conversation. '}
                {chat.error}
              </ErrorNote>
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
                onSave={(text) =>
                  references.open({ kind: 'new', content: text, sourceNodeId: node.id })
                }
                messages={chat.messages}
                runs={runs}
                pending={chat.pending}
                running={chat.running}
                phase={activity?.state ?? 'working'}
                onProjectSettings={onProjectSettings}
                pinLatest
              />
            )}
          </div>
        </div>
        {/*
         * A pill over the thread, not a row in the footer: a full-width button
         * under the conversation pushed the composer down while you were
         * reading, and this is only true while you are away from the bottom.
         */}
        {reading.away && (
          <button className="jump-latest" onClick={reading.jump}>
            <Icon name="arrowDown" />
            {reading.unread ? 'New output' : 'Jump to latest'}
          </button>
        )}
      </div>

      <div className="panel-foot">
        {(node.status === 'interrupted' || (detail?.partialWork?.changed.length ?? 0) > 0) &&
          node.status !== 'running' &&
          node.status !== 'needs_you' && (
            <Recovery
              node={node}
              runs={runs}
              isYourFolder={isYourFolder}
              busy={actions.busy}
              partialWork={detail?.partialWork ?? null}
              onRecover={(action) => void actions.recover(node, action)}
            />
          )}
        {error !== null && <ErrorNote onDismiss={() => setError(null)}>{error}</ErrorNote>}
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
        {/* The latest run's numbers, in the place the activity strip holds while it runs. */}
        {!chat.busy && latestRun?.status === 'done' && <RunFoot run={latestRun} label="Last run" />}
        {!chat.busy && node.folder === 'archived' && (
          <p className="run-foot pinned archived-note">
            <Icon name="archive" />
            Folder archived · the next message brings it back and runs setup again
          </p>
        )}
        {node.pendingQuestion === null && (
          <Composer
            node={node}
            busy={chat.busy}
            sending={chat.sending}
            value={chat.prompt}
            onChange={chat.setPrompt}
            onSend={chat.send}
            attached={chat.attached}
            onAttach={chat.setAttached}
            nextRun={chat.busy ? null : (detail?.nextRunSettings ?? null)}
            onProjectSettings={onProjectSettings}
          />
        )}
      </div>

      {actions.confirmDialog}
    </aside>
  );
}
