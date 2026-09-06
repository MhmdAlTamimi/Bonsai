import { type JSX, useEffect, useState } from 'react';
import type { NodeDetail, NodeView } from '@bonsai/shared';
import { ApiCallError, api } from '../api/client.ts';
import { CODE_LABEL, codeState } from '../nodeCode.ts';

/**
 * The side panel. Contents per node state (PRD §5 / D34).
 *
 * Five states, not six: a failed run lands the node in `interrupted` and is
 * distinguished by the run's error text.
 */
export function Panel({
  node,
  onChanged,
}: {
  node: NodeView | null;
  onChanged: () => void;
}): JSX.Element {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [childName, setChildName] = useState('');
  const [childDesc, setChildDesc] = useState('');

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (node === null) return;
    let live = true;
    void api
      .node(node.id)
      .then((d) => live && setDetail(d))
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [node?.id, node?.status, node?.displayName]);

  if (node === null) {
    return (
      <aside className="panel empty">
        <p>Select a node.</p>
      </aside>
    );
  }

  const createChild = async (): Promise<void> => {
    setError(null);
    try {
      await api.createNode(node.projectId, {
        parentId: node.id,
        displayName: childName.trim() || 'untitled',
        description: childDesc.trim(),
      });
      setChildName('');
      setChildDesc('');
      onChanged();
    } catch (e) {
      setError(describe(e));
    }
  };

  return (
    <aside className="panel">
      <header>
        <h2>{node.displayName}</h2>
        <span className={`pill status-${node.status}`}>{node.status.replace('_', ' ')}</span>
      </header>

      <dl className="facts">
        <div>
          <dt>code</dt>
          <dd>{CODE_LABEL[codeState(node)]}</dd>
        </div>
        <div>
          <dt>writable</dt>
          <dd>{node.writable ? 'yes, nothing has branched off it' : 'frozen — a child committed'}</dd>
        </div>
        <div>
          <dt>cost</dt>
          <dd>{node.costUsd > 0 ? `$${node.costUsd.toFixed(4)}` : '—'}</dd>
        </div>
      </dl>

      {detail?.baseIsPinnedBehindLiveWalk === true && (
        <p className="note">
          An ancestor has committed since this node was created. Its base stays pinned where it
          was, so its code and its inherited conversation still describe the same tree.
        </p>
      )}

      <StateBody node={node} detail={detail} />

      {/* D5: to make a change you explicitly create a child. */}
      <section className="create-child">
        <h3>Create a child</h3>
        <input
          value={childName}
          onChange={(e) => setChildName(e.target.value)}
          placeholder="name"
          aria-label="child name"
        />
        <textarea
          value={childDesc}
          onChange={(e) => setChildDesc(e.target.value)}
          placeholder="what should change?"
          aria-label="child description"
          rows={3}
        />
        <button onClick={() => void createChild()}>Create</button>
        <p className="hint">
          The node keeps a branch only if its run changes files. Ask a question and it stays
          conversation-only; its own children will branch from here regardless.
        </p>
      </section>

      {error !== null && <p className="error">{error}</p>}
    </aside>
  );
}

function StateBody({ node, detail }: { node: NodeView; detail: NodeDetail | null }): JSX.Element {
  switch (node.status) {
    case 'new':
      return (
        <section>
          <p className="summary">{node.summaryLine}</p>
          <button disabled>Start</button>
          <p className="hint">
            <strong>not started</strong> means no agent has run on this node yet — it exists in
            the tree and holds your description, but nothing has read or written any code for it.
          </p>
          <p className="hint">
            You will rarely see this state in the finished product: creating a node starts its run
            straight away and it goes to <em>running</em> without stopping here (§6.2). The agent
            layer lands in M3, so until then a new node just waits.
          </p>
        </section>
      );
    case 'running':
      return (
        <section>
          <p className="muted">Agent working…</p>
          <pre className="stream">{/* run.delta frames land here in M3 */}</pre>
          <button disabled title="cancellation lands in M3">
            Cancel
          </button>
        </section>
      );
    case 'needs_you':
      return (
        <section>
          <p className="question">{node.pendingQuestion?.text ?? 'The agent asked a question.'}</p>
          <textarea placeholder="reply" rows={3} disabled />
          <p className="hint">The ask-user mechanism is postponed; this state is unreachable.</p>
        </section>
      );
    case 'ready':
      return (
        <section>
          <p className="summary">{node.summaryLine}</p>
          <h3>Transcript</h3>
          <p className="muted">
            {detail === null ? 'loading…' : `${detail.runs.length} run(s) recorded.`}
          </p>
          {node.hasCommits ? (
            <p className="muted">Diff lands in M2.</p>
          ) : (
            <p className="muted">No diff — this node ran and committed nothing.</p>
          )}
        </section>
      );
    case 'interrupted':
      return (
        <section>
          <p className="error">
            {detail?.runs.at(-1)?.error ?? 'The run was killed or failed midway.'}
          </p>
          <div className="row">
            <button disabled>Resume</button>
            <button disabled>Discard</button>
            <button disabled>Keep</button>
          </div>
          <p className="hint">Recovery lands in M4.</p>
        </section>
      );
  }
}

function describe(e: unknown): string {
  if (e instanceof ApiCallError) {
    return e.milestone === undefined ? e.message : `${e.message} (not built yet)`;
  }
  return String(e);
}
