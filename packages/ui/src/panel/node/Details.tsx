import type { JSX } from 'react';
import type { NodeDetail, NodeView, RunView } from '@bonsai/shared';

import { CODE_LABEL, CODE_TOOLTIP, codeState } from '../../nodeCode.ts';

/**
 * Facts about the node, read occasionally rather than constantly, so behind a
 * disclosure rather than on the surface (§7: the conversation is the
 * workspace).
 */
export function Details({
  node,
  detail,
  runs,
  isYourFolder,
}: {
  node: NodeView;
  detail: NodeDetail | null;
  runs: readonly RunView[];
  isYourFolder: boolean;
}): JSX.Element {
  const latest = runs.at(-1);
  return (
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
        {/* What 1.4 started capturing, made visible: the agent's behaviour
            becomes legible rather than magic. */}
        {latest !== undefined && (
          <>
            <div>
              <dt>last run</dt>
              <dd>
                {latest.durationMs === null ? '—' : `${(latest.durationMs / 1000).toFixed(1)}s`}
                {latest.toolCalls > 0 &&
                  `, ${latest.toolCalls} tool call${latest.toolCalls === 1 ? '' : 's'}`}
              </dd>
            </div>
            <div>
              <dt>tools</dt>
              <dd title={latest.toolsOffered?.join(', ') ?? undefined}>
                {latest.toolsOffered === null
                  ? 'not recorded'
                  : `${latest.toolsOffered.length} offered — ${latest.toolsOffered.slice(0, 6).join(', ')}${latest.toolsOffered.length > 6 ? '…' : ''}`}
              </dd>
            </div>
          </>
        )}
        <Cost node={node} runs={runs} />
      </dl>
      {detail?.contextMd != null && (
        <>
          <h3>CONTEXT.md</h3>
          <pre className="stream">{detail.contextMd}</pre>
        </>
      )}
    </details>
  );
}

function Cost({
  node,
  runs,
}: {
  node: NodeView;
  runs: ReadonlyArray<{
    costUsd: number;
    model: string | null;
    apiKeySource: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
  }>;
}): JSX.Element {
  const model = runs
    .map((r) => r.model)
    .filter((m): m is string => m !== null)
    .at(-1);
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
