import type { JSX } from 'react';
import type { NextRunSettings } from '@bonsai/shared';
import { PERMISSIONS } from './AgentFields.tsx';

/**
 * What a run that has not happened yet would use.
 *
 * Only the creation dialog shows this now: there it is part of the decision
 * being made. In the conversation it described a future run in the middle of
 * the past ones, so it moved into the composer's ⋯ (see Composer).
 */
export function NextRunInfo({
  value,
  onSettings,
}: {
  value: NextRunSettings;
  onSettings?: () => void;
}): JSX.Element {
  return (
    <details className="next-run">
      <summary>Next run · {value.model ?? 'Agent default'}</summary>
      <dl>
        <div>
          <dt>Model</dt>
          <dd>
            {value.model ?? 'Agent default'} <small>{value.modelSource}</small>
          </dd>
        </div>
        <div>
          <dt>Effort</dt>
          <dd>
            {value.effort ?? 'Agent default'} <small>{value.effortSource}</small>
          </dd>
        </div>
        <div>
          <dt>Permissions</dt>
          <dd>
            {PERMISSIONS[value.permissionMode]} <small>{value.permissionSource}</small>
          </dd>
        </div>
      </dl>
      {onSettings && (
        <button className="linkish" onClick={onSettings}>
          Project settings
        </button>
      )}
    </details>
  );
}
