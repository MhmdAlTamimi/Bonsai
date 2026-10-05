import type { JSX } from 'react';
import type { NextRunSettings, ProjectSetupView } from '@bonsai/shared';
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
  setup,
}: {
  value: NextRunSettings;
  onSettings?: () => void;
  setup?: ProjectSetupView;
}): JSX.Element {
  return (
    <details className="next-run">
      <summary>
        <span>Run settings</span>
        <span className="creation-run-summary">
          <span title={value.model ?? 'Agent default'}>{value.model ?? 'Agent default'}</span>
          <span>{value.effort ? `${value.effort} effort` : 'Default effort'}</span>
          <span>{PERMISSIONS[value.permissionMode]}</span>
        </span>
      </summary>
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
      {setup && (setup.copyFiles.length > 0 || setup.setupCommand) && (
        <div className="creation-setup">
          <h4>Experiment setup</h4>
          {setup.copyFiles.length > 0 && <p>Copy: {setup.copyFiles.join(', ')}</p>}
          {setup.setupCommand && <pre>{setup.setupCommand}</pre>}
        </div>
      )}
      {onSettings && (
        <button className="linkish" onClick={onSettings}>
          Project settings
        </button>
      )}
    </details>
  );
}
