import type { JSX } from 'react';
import type { NodeDetail, NodeView, RunView } from '@bonsai/shared';

import { CODE_LABEL, CODE_TOOLTIP, codeState } from '../../nodeCode.ts';
import { exactTime, relativeTime } from '../chat/time.ts';

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
          <dt>created</dt>
          <dd title={exactTime(node.createdAt)}>{relativeTime(node.createdAt)}</dd>
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
        {/* Last, and monospace: nobody reads this until they are reporting a
            problem, and then it is the first thing asked for. */}
        <div>
          <dt>node id</dt>
          <dd>
            <code>{node.id}</code>
          </dd>
        </div>
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
