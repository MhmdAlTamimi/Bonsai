import { type JSX, useEffect, useState } from 'react';
import type { NodeDetail, NodeView } from '@bonsai/shared';
import { ApiCallError, type NodeDiffView, api } from '../api/client.ts';
import { CODE_LABEL, codeState } from '../nodeCode.ts';

/**
 * The side panel. Contents per node state (PRD §5 / D34).
 *
 * Five states, not six: a failed run lands the node in `interrupted` and is
 * distinguished by the run's error text.
 */
export function Panel({
  node,
  stream,
  onChanged,
}: {
  node: NodeView | null;
  stream: string[];
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
  }, [node?.id, node?.status]);

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
      const { node: child } = await api.createNode(node.projectId, {
        parentId: node.id,
        displayName: childName.trim() || 'untitled',
        description: childDesc.trim(),
      });
      // §6.2: the user stays on the canvas and the node starts working.
      await api.startRun(child.id, childDesc.trim() || childName.trim());
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
          <dt>est. cost</dt>
          <dd>{node.costUsd > 0 ? `$${node.costUsd.toFixed(4)}` : '—'}</dd>
        </div>
      </dl>

      {detail?.baseIsPinnedBehindLiveWalk === true && (
        <p className="note">
          An ancestor has committed since this node was created. Its base stays pinned where it
          was, so its code and its inherited conversation still describe the same tree.
        </p>
      )}

      <StateBody node={node} detail={detail} stream={stream} onChanged={onChanged} setError={setError} />

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
          placeholder="what should change? start with ? to just ask"
          aria-label="child description"
          rows={3}
        />
        <button onClick={() => void createChild()}>Create and run</button>
        <p className="hint">
          The node keeps a branch only if its run changes files. Start with <code>?</code> and the
          stand-in agent answers without writing anything, so the node stays conversation-only —
          its own children still branch from here.
        </p>
      </section>

      {error !== null && <p className="error">{error}</p>}
    </aside>
  );
}

function StateBody({
  node,
  detail,
  stream,
  onChanged,
  setError,
}: {
  node: NodeView;
  detail: NodeDetail | null;
  stream: string[];
  onChanged: () => void;
  setError: (e: string | null) => void;
}): JSX.Element {
  const [prompt, setPrompt] = useState('');

  const start = async (): Promise<void> => {
    setError(null);
    try {
      await api.startRun(node.id, prompt.trim() || node.summaryLine);
      setPrompt('');
      onChanged();
    } catch (e) {
      setError(describe(e));
    }
  };

  const cancel = async (): Promise<void> => {
    const run = detail?.runs.find((r) => r.status === 'running');
    if (run === undefined) return;
    try {
      await api.cancelRun(run.id);
      onChanged();
    } catch (e) {
      setError(describe(e));
    }
  };

  switch (node.status) {
    case 'new':
      return (
        <section>
          <p className="summary">{node.summaryLine}</p>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={node.summaryLine || 'what should the agent do?'}
            rows={3}
            aria-label="prompt"
          />
          <button onClick={() => void start()}>Start</button>
          <p className="hint">
            <strong>not started</strong> means no agent has run on this node yet — it exists in
            the tree and holds your description, but nothing has read or written any code for it.
          </p>
        </section>
      );

    case 'running':
      return (
        <section>
          <p className="muted">Agent working…</p>
          <pre className="stream">{stream.join('\n') || '…'}</pre>
          <button onClick={() => void cancel()}>Cancel</button>
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
          <Transcript detail={detail} />
          <Diff node={node} />
          {node.writable ? (
            <>
              <h3>Chat with this node</h3>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="another change, or ? to just ask"
                rows={3}
                aria-label="prompt"
              />
              <button onClick={() => void start()}>Run</button>
              <p className="hint">
                §6.3: each run that changes files adds another commit to this same node. The tree
                does not change.
              </p>
            </>
          ) : (
            <p className="hint">
              Frozen: a child has committed, so this node cannot change any more. Create a child
              to carry on from here.
            </p>
          )}
        </section>
      );

    case 'interrupted':
      return (
        <section>
          <p className="error">
            {detail?.runs.at(-1)?.error ?? 'The run was killed or failed midway.'}
          </p>
          <Transcript detail={detail} />
          <div className="row">
            <button disabled>Resume</button>
            <button disabled>Discard</button>
            <button disabled>Keep</button>
          </div>
          <p className="hint">Recovery lands in M4. The worktree is left as the run found it.</p>
        </section>
      );
  }
}

function Transcript({ detail }: { detail: NodeDetail | null }): JSX.Element {
  const runs = detail?.runs ?? [];
  const cost = runs.reduce((sum, r) => sum + r.costUsd, 0);
  const cacheRead = runs.reduce((sum, r) => sum + r.cacheReadTokens, 0);
  const input = runs.reduce((sum, r) => sum + r.inputTokens, 0);
  const output = runs.reduce((sum, r) => sum + r.outputTokens, 0);
  const model = runs.map((r) => r.model).filter((m): m is string => m !== null).at(-1);

  return (
    <>
      <h3>Runs</h3>
      <p className="muted">
        {detail === null
          ? 'loading…'
          : `${runs.length} run(s)${cost > 0 ? `, $${cost.toFixed(4)} estimated` : ''}`}
      </p>
      {model !== undefined && (
        <p className="muted">
          model <code>{model}</code>
        </p>
      )}
      {(input > 0 || output > 0) && (
        <p className="muted">
          {input.toLocaleString()} in / {output.toLocaleString()} out
          {cacheRead > 0 && ` · ${cacheRead.toLocaleString()} from cache`}
        </p>
      )}
      {cost > 0 && (
        <p className="hint">
          An estimate at API list price, not a bill. On a Claude subscription
          nothing is charged per token — this is what these tokens would have cost
          through the API. Cost grows with depth: a node replays its whole
          ancestor conversation on every run.
        </p>
      )}
      {detail?.contextMd != null && (
        <details>
          <summary className="muted">CONTEXT.md</summary>
          <pre className="stream">{detail.contextMd}</pre>
        </details>
      )}
    </>
  );
}

function Diff({ node }: { node: NodeView }): JSX.Element {
  const [diff, setDiff] = useState<NodeDiffView | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || !node.hasCommits) return;
    let live = true;
    void api.diff(node.id).then((d) => live && setDiff(d)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open, node.id, node.hasCommits]);

  if (!node.hasCommits) {
    return <p className="muted">No diff — this node ran and committed nothing.</p>;
  }

  return (
    <>
      <h3>Diff</h3>
      <button onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Show'} diff</button>
      {open && diff !== null && (
        <>
          <p className="muted">{diff.files.join(', ') || 'no files'}</p>
          <pre className="stream">{diff.patch}</pre>
        </>
      )}
    </>
  );
}

function describe(e: unknown): string {
  if (e instanceof ApiCallError) {
    return e.milestone === undefined ? e.message : `${e.message} (not built yet)`;
  }
  return String(e);
}
