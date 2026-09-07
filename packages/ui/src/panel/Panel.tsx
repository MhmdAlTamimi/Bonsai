import { type JSX, useEffect, useState } from 'react';
import type { NodeDetail, NodeView, RecoverAction } from '@bonsai/shared';
import { ApiCallError, api } from '../api/client.ts';
import { CODE_LABEL, CODE_TOOLTIP, codeState } from '../nodeCode.ts';
import { Chat } from './Chat.tsx';

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
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(null);
    if (node === null) {
      setDetail(null);
      return;
    }
    let alive = true;
    void api
      .node(node.id)
      .then((d) => alive && setDetail(d))
      .catch((e: unknown) => alive && setError(String(e)));
    return () => {
      alive = false;
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
    setBusy(true);
    try {
      const { node: child } = await api.createNode(node.projectId, {
        parentId: node.id,
        displayName: childName.trim() || 'untitled',
        description: childDesc.trim(),
      });
      await api.startRun(child.id, childDesc.trim() || childName.trim());
      setChildName('');
      setChildDesc('');
      onChanged();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };

  const recover = async (action: RecoverAction): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await api.recover(node.id, action);
      onChanged();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
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

  const runs = detail?.runs ?? [];

  return (
    <aside className="panel">
      <header>
        <h2 title={node.displayName}>{node.displayName}</h2>
        <div className="header-right">
          {node.status === 'running' && (
            <button className="linkish" onClick={() => void cancel()}>
              cancel
            </button>
          )}
          <span className={`pill status-${node.status}`}>{node.status.replace('_', ' ')}</span>
        </div>
      </header>

      {/* §6.6: the one state that must interrupt you, because it needs a decision. */}
      {node.status === 'interrupted' && (
        <div className="recover">
          <p className="error">{runs.at(-1)?.error ?? 'The run was killed or failed midway.'}</p>
          <p className="hint">
            Whatever the run had written is still in place. Resume tells the agent what actually
            landed and asks it to finish; discard throws those changes away; keep leaves them
            alone and unflags the node.
          </p>
          <div className="row">
            <button disabled={busy} onClick={() => void recover('resume')}>
              Resume
            </button>
            <button disabled={busy} onClick={() => void recover('discard')}>
              Discard
            </button>
            <button disabled={busy} onClick={() => void recover('keep')}>
              Keep
            </button>
          </div>
        </div>
      )}

      {detail?.baseIsPinnedBehindLiveWalk === true && (
        <p className="note">
          An ancestor has committed since this node was created. Its base stays pinned where it
          was, so its code and its inherited conversation still describe the same tree.
        </p>
      )}

      <Chat node={node} runs={runs} live={stream} onChanged={onChanged} onError={setError} />

      {error !== null && <p className="error">{error}</p>}

      <details className="disclosure">
        <summary>Details</summary>
        <dl className="facts">
          <div>
            <dt>code</dt>
            <dd title={CODE_TOOLTIP[codeState(node)]}>{CODE_LABEL[codeState(node)]}</dd>
          </div>
          <div>
            <dt>writable</dt>
            <dd>
              {node.writable ? 'yes, nothing has branched off it' : 'frozen — a child committed'}
            </dd>
          </div>
          <div>
            <dt>runs</dt>
            <dd>{runs.length}</dd>
          </div>
          <Cost node={node} runs={runs} />
        </dl>
        {detail?.contextMd != null && (
          <>
            <h3>CONTEXT.md</h3>
            <pre className="stream">{detail.contextMd}</pre>
          </>
        )}
      </details>

      {/* D5: to make a change you explicitly create a child. */}
      <details className="disclosure">
        <summary>Create a child</summary>
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
        <button disabled={busy} onClick={() => void createChild()}>
          Create and run
        </button>
        <p className="hint">
          A child forks this node's whole conversation, and branches from the nearest ancestor
          that has a commit — which is not this node if it changed no files.
        </p>
      </details>
    </aside>
  );
}

function Cost({
  node,
  runs,
}: {
  node: NodeView;
  runs: readonly { costUsd: number; model: string | null; apiKeySource: string | null }[];
}): JSX.Element {
  const model = runs.map((r) => r.model).filter((m): m is string => m !== null).at(-1);
  // 'none' is a claude.ai subscription login: nothing is charged per token.
  const subscription = runs.some((r) => r.apiKeySource === 'none');

  return (
    <>
      <div>
        <dt>{subscription ? 'tokens ≈' : 'est. cost'}</dt>
        <dd title="Computed by the SDK from token counts and list prices. Not a bill.">
          {node.costUsd > 0 ? `$${node.costUsd.toFixed(4)}` : '—'}
          {subscription && node.costUsd > 0 && (
            <span className="hint"> API-equivalent; your subscription is billed monthly.</span>
          )}
        </dd>
      </div>
      {model !== undefined && (
        <div>
          <dt>model</dt>
          <dd>
            <code>{model}</code>
          </dd>
        </div>
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
