import { type JSX, useEffect, useState } from 'react';
import type { NodeDetail, NodeView, ProjectView } from '@bonsai/shared';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import { Chat } from './Chat.tsx';
import { Checks } from './node/Checks.tsx';
import { Checkout } from './node/Checkout.tsx';
import { CreateChild } from './node/CreateChild.tsx';
import { Details } from './node/Details.tsx';
import { Recover } from './node/Recover.tsx';
import { useNodeActions } from './node/useNodeActions.ts';
import { StatusChip } from '../nodeStatus.tsx';

/**
 * The side panel, built around the conversation.
 *
 * §7 calls the conversation the primary workspace, so it gets the space and the
 * focus: messages, then the box you reply in, directly beneath them. Everything
 * else -- facts, runs, cost, CONTEXT.md, creating a child -- is detail below or
 * behind a disclosure, because it is read occasionally and the chat is read
 * constantly.
 *
 * The five panel states of §5 / D34 are still all here; they just no longer
 * each own a slab of the panel. `running` and `ready` differ inside the chat
 * (a disabled composer, a working indicator) rather than by swapping the whole
 * body out, which is what used to make a finished run look like it had lost
 * everything you had just watched.
 */
export function Panel({
  project,
  node,
  stream,
  onChanged,
}: {
  /** Needed only to explain why an adopted project's master cannot be written. */
  project: ProjectView | null;
  node: NodeView | null;
  stream: string[];
  onChanged: () => void;
}): JSX.Element {
  if (node === null) {
    return (
      <aside className="panel empty">
        <p>Select a node.</p>
      </aside>
    );
  }
  // Deliberately NOT keyed on node.id. Keying would remount on every node
  // switch and clear a half-typed child name -- arguably better, and a
  // behaviour change, which this split is not allowed to be.
  return <NodePanel project={project} node={node} stream={stream} onChanged={onChanged} />;
}

function NodePanel({
  project,
  node,
  stream,
  onChanged,
}: {
  project: ProjectView | null;
  node: NodeView;
  stream: string[];
  onChanged: () => void;
}): JSX.Element {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = useNodeActions(node, onChanged, setError);

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
   * read-only from the start rather than after a child commits -- and why the
   * panel says so instead of leaving a permanently frozen node unexplained.
   *
   * Read off the node, not worked out from the project here: the server decides
   * what `writable` means and says why, so nothing can disagree with it.
   */
  const isYourFolder = node.frozenReason === 'your_folder';

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
          {node.parentId !== null && (
            <button
              className="linkish danger"
              onClick={() => void actions.remove()}
              disabled={actions.busy}
            >
              delete
            </button>
          )}
          <StatusChip status={node.status} queuePosition={node.queuePosition} />
        </div>
      </header>

      {isYourFolder && (
        <p className="note" title={project?.sourcePath ?? undefined}>
          Your own folder — read only. Drag out a child to make changes.
        </p>
      )}

      {node.status === 'interrupted' && (
        <Recover
          runs={runs}
          isYourFolder={isYourFolder}
          busy={actions.busy}
          onRecover={(action) => void actions.recover(action)}
        />
      )}

      {detail?.baseIsPinnedBehindLiveWalk === true && (
        <p
          className="note"
          title="Its base stays pinned where it was, so its code and its inherited conversation still describe the same tree."
        >
          An ancestor has committed since this node branched.
        </p>
      )}

      <Checks node={node} detail={detail} />

      <Chat node={node} runs={runs} live={stream} onChanged={onChanged} onError={setError} />

      {error !== null && <p className="error">{error}</p>}

      {detail?.checkoutCommand != null && (
        <Checkout command={detail.checkoutCommand} hint={detail.checkoutHint} onError={setError} />
      )}

      <Details node={node} detail={detail} runs={runs} isYourFolder={isYourFolder} />

      <CreateChild actions={actions} />
    </aside>
  );
}
