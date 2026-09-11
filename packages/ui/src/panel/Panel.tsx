import { type JSX, useEffect, useState } from 'react';
import type { NodeDetail, NodeView, ProjectView, RecoverAction } from '@bonsai/shared';
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

  /**
   * D7 cascades to every descendant and B9 (soft delete) is deferred, so this
   * is irreversible and destroys paid, unreproducible work. The impact is
   * fetched and stated before asking — the cheap part of B9, worth having now.
   */
  const remove = async (): Promise<void> => {
    setError(null);
    try {
      const impact = await api.deletionImpact(node.id);
      const others = impact.nodes - 1;
      const spent = impact.costUsd > 0 ? `, about $${impact.costUsd.toFixed(2)} of agent runs` : '';
      const descendants = others > 0 ? ` and ${others} descendant${others === 1 ? '' : 's'}` : '';
      if (
        !window.confirm(
          `Delete "${node.displayName}"${descendants}?\n\n` +
            `This permanently removes ${impact.nodes} node${impact.nodes === 1 ? '' : 's'}${spent}, ` +
            `${impact.commits} commit-bearing branch${impact.commits === 1 ? '' : 'es'}, and their ` +
            `worktrees on disk. It cannot be undone.`,
        )
      ) {
        return;
      }
      setBusy(true);
      await api.deleteNode(node.id);
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
          {node.status === 'running' && (
            <button className="linkish" onClick={() => void cancel()}>
              cancel
            </button>
          )}
          {node.parentId !== null && (
            <button className="linkish danger" onClick={() => void remove()} disabled={busy}>
              delete
            </button>
          )}
          <span className={`pill status-${node.status}`}>{node.status.replace('_', ' ')}</span>
        </div>
      </header>

      {isYourFolder && (
        <p className="note">
          This node is your own folder{project?.sourcePath == null ? '' : ` (${project.sourcePath})`}
          . Bonsai reads it and answers questions about it, but never writes or commits there — to
          change anything, drag out a child node. Children get their own worktree on a{' '}
          <code>node/…</code> branch inside this same repository, so you can check them out with
          git whenever you like.
        </p>
      )}

      {/* §6.6: the one state that must interrupt you, because it needs a decision. */}
      {node.status === 'interrupted' && (
        <div className="recover">
          <p className="error">{runs.at(-1)?.error ?? 'The run was killed or failed midway.'}</p>
          <p className="hint">
            {isYourFolder
              ? 'Nothing was written — this node only reads. Resume asks the agent to carry on; keep unflags the node.'
              : 'Whatever the run had written is still in place. Resume tells the agent what actually landed and asks it to finish; discard throws those changes away; keep leaves them alone and unflags the node.'}
          </p>
          <div className="row">
            <button disabled={busy} onClick={() => void recover('resume')}>
              Resume
            </button>
            {/* Not offered for the user's own folder: discard is a hard reset
                plus a clean, and there it would destroy work Bonsai never made. */}
            {!isYourFolder && (
              <button disabled={busy} onClick={() => void recover('discard')}>
                Discard
              </button>
            )}
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
              {node.writable
                ? 'yes, nothing has branched off it'
                : isYourFolder
                  ? 'no — this is your own folder, so Bonsai only reads it'
                  : 'frozen — a child committed'}
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
  runs: readonly {
    costUsd: number;
    model: string | null;
    apiKeySource: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
  }[];
}): JSX.Element {
  const model = runs.map((r) => r.model).filter((m): m is string => m !== null).at(-1);
  // 'none' is a claude.ai subscription login: nothing is charged per token.
  const subscription = runs.some((r) => r.apiKeySource === 'none');
  const input = runs.reduce((n, r) => n + r.inputTokens, 0);
  const output = runs.reduce((n, r) => n + r.outputTokens, 0);
  const cacheRead = runs.reduce((n, r) => n + r.cacheReadTokens, 0);

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
      {(input > 0 || output > 0) && (
        <div>
          <dt>tokens</dt>
          <dd title="Cached input is replayed ancestor conversation, and costs a fraction of fresh input.">
            {input.toLocaleString()} in · {output.toLocaleString()} out
            {cacheRead > 0 && <> · {cacheRead.toLocaleString()} cached</>}
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
