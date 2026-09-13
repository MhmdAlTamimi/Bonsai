import { type JSX, useEffect, useRef, useState } from 'react';
import type { NodeDetail, NodeView, ProjectView } from '@bonsai/shared';

import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import { Checks } from './node/Checks.tsx';
import { Checkout } from './node/Checkout.tsx';
import { Details } from './node/Details.tsx';
import { Lineage } from './node/Lineage.tsx';
import { Recover } from './node/Recover.tsx';
import { StartRun } from './node/StartRun.tsx';
import { useNodeActions } from './node/useNodeActions.ts';
import { StatusChip } from '../nodeStatus.tsx';
import { AskBox } from './node/AskBox.tsx';
import { Composer } from './chat/Composer.tsx';
import { Transcript } from './chat/Transcript.tsx';
import { useChat } from './chat/useChat.ts';
import type { Delta } from './chat/liveMerge.ts';

/**
 * The side panel, ordered by what the node can actually do.
 *
 * It used to run header, notes, checks, chat, "Get this branch", details,
 * create-a-child -- an order that follows how the thing was built rather than
 * what anyone does with it. Two consequences, both bad:
 *
 *   A node freezes as soon as a child commits, so MOST nodes in a tree are
 *   frozen. On a frozen node the top of the panel was a three-row textarea,
 *   disabled, explaining that it was disabled -- while the one action available
 *   (branch a child off it) sat last, collapsed, below the fold.
 *
 *   "Get this branch" is what you do once, at the end, when you have picked a
 *   winner. It outranked the thing you do constantly.
 *
 * So the layout is now a function of state: `new` leads with Start (PRD §5,
 * which was never implemented), `interrupted` leads with recovery, frozen nodes
 * lead with the branch action and collapse the composer to one line, and a
 * writable leaf leads with the conversation.
 */
export function Panel({
  project,
  node,
  stream,
  onChanged,
  onCreateChild,
}: {
  /** Needed only to explain why an adopted project's master cannot be written. */
  project: ProjectView | null;
  node: NodeView | null;
  stream: readonly Delta[];
  onChanged: () => void;
  /** Opens the one create-a-child dialog. See NewChildDialog. */
  onCreateChild: (node: NodeView) => void;
}): JSX.Element {
  if (node === null) {
    return (
      <aside className="panel empty">
        <p className="muted">Select a node to see its conversation.</p>
        <p className="hint">Drag out of a node&rsquo;s handle to branch a new one.</p>
      </aside>
    );
  }
  // Deliberately NOT keyed on node.id. Keying would remount on every node
  // switch and clear a half-typed message.
  return (
    <NodePanel
      project={project}
      node={node}
      stream={stream}
      onChanged={onChanged}
      onCreateChild={onCreateChild}
    />
  );
}

function NodePanel({
  project,
  node,
  stream,
  onChanged,
  onCreateChild,
}: {
  project: ProjectView | null;
  node: NodeView;
  stream: readonly Delta[];
  onChanged: () => void;
  onCreateChild: (node: NodeView) => void;
}): JSX.Element {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = useNodeActions(node, onChanged, setError);
  const chat = useChat(node, stream, onChanged, setError);

  useEffect(() => {
    setError(null);
    let alive = true;
    void api
      .node(node.id)
      .then((d) => alive && setDetail(d))
      .catch((e: unknown) => alive && setError(describeError(e)));
    return () => {
      alive = false;
    };
    // Deliberately not `[node]`. A refetch hands back a new object every time,
    // so depending on it would refetch the detail in a loop; the id and the
    // status are the only parts this effect actually reads.
  }, [node.id, node.status]);

  const runs = detail?.runs ?? [];

  /**
   * Master of an adopted project: its worktree is the user's own folder, on the
   * branch they work on. Bonsai will not write there, which is why the node is
   * read-only from the start rather than after a child commits.
   */
  const isYourFolder = node.frozenReason === 'your_folder';
  const frozen = !node.writable;

  const branchButton = (
    <button className="branch-child" onClick={() => onCreateChild(node)}>
      <span aria-hidden="true">+</span> Branch a child from this node
    </button>
  );

  return (
    <aside className="panel">
      <header>
        <h2 title={node.displayName}>{node.displayName}</h2>
        <div className="header-right">
          {/* A node parked on a question is still holding an agent and a
              concurrency slot, so it needs the same way out as a running one. */}
          {(node.status === 'running' || node.status === 'needs_you') && (
            <button className="stop" onClick={() => void actions.cancel()}>
              ■ Stop
            </button>
          )}
          <StatusChip status={node.status} queuePosition={node.queuePosition} />
          {node.parentId !== null && (
            <OverflowMenu busy={actions.busy} onDelete={() => void actions.remove()} />
          )}
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

      {/*
       * The one scrolling region. The transcript used to scroll inside this,
       * which scrolled inside the panel, so the wheel did different things two
       * centimetres apart. Everything that is read scrolls together; only the
       * composer is pinned, because a reply box you have to scroll to find is a
       * reply box you stop using.
       */}
      <div className="panel-body" ref={chat.scrollRef}>
        {node.status === 'interrupted' && (
          <Recover
            runs={runs}
            isYourFolder={isYourFolder}
            busy={actions.busy}
            onRecover={(action) => void actions.recover(action)}
          />
        )}

        {node.status === 'new' && (
          <StartRun node={node} busy={actions.busy} onStart={(p) => void actions.start(p)} />
        )}

        <Checks node={node} detail={detail} />

        {detail !== null && <Lineage lineage={detail.lineage} />}

        {/* Frozen: the action first, the conversation second. The composer knows
            to collapse itself, so the chat below costs one line until asked for. */}
        {frozen && branchButton}

        {chat.messages.length === 0 && chat.pending.length === 0 && !chat.running ? (
          <p className="muted chat-empty">
            No conversation yet. Ask for a change, or ask a question — a question that changes no
            files leaves this node conversation-only.
          </p>
        ) : (
          <Transcript
            messages={chat.messages}
            runs={runs}
            pending={chat.pending}
            running={chat.running}
          />
        )}

        {error !== null && <p className="error">{error}</p>}

        {!frozen && branchButton}

        <Details node={node} detail={detail} runs={runs} isYourFolder={isYourFolder} />

        {detail?.checkoutCommand != null && (
          <Checkout
            command={detail.checkoutCommand}
            hint={detail.checkoutHint}
            onError={setError}
          />
        )}
      </div>

      <div className="panel-foot">
        <AskBox node={node} onAnswered={onChanged} onError={setError} />
        <Composer
          node={node}
          busy={chat.busy}
          sending={chat.sending}
          emphasised={node.status !== 'new'}
          value={chat.prompt}
          onChange={chat.setPrompt}
          onSend={chat.send}
        />
      </div>

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
function OverflowMenu({ busy, onDelete }: { busy: boolean; onDelete: () => void }): JSX.Element {
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
            className="danger"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            Delete this node…
          </button>
        </div>
      )}
    </div>
  );
}
