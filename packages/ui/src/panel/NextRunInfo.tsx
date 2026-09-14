import type { JSX } from 'react';
import type { NextRunSettings } from '@bonsai/shared';
import { PERMISSIONS } from './AgentFields.tsx';
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
