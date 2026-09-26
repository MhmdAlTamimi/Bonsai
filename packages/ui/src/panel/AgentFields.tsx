import { EFFORTS, type AgentModel, type PermissionMode } from '@bonsai/shared';
import type { JSX } from 'react';

import { pickerModels } from './models.ts';
export const PERMISSIONS: Record<PermissionMode, string> = {
  acceptEdits: 'Allow tools and commands',
  default: 'Ask before changes',
  bypassPermissions: 'Bypass permission checks',
  plan: 'Plan (SDK mode)',
};
export interface AgentValues {
  model: string | null;
  effort: string | null;
  permissionMode: PermissionMode;
}
export function AgentFields({
  value,
  onChange,
  disabled,
  inherited = false,
  models,
}: {
  value: AgentValues;
  onChange: (value: AgentValues) => void;
  disabled: boolean;
  inherited?: boolean;
  /** What Claude Code reported this credential can use; joined with the built-in list. */
  models?: readonly AgentModel[] | undefined;
}): JSX.Element {
  const offered = pickerModels(models);
  const chosen = offered.find((m) => m.id === value.model);
  // Only the levels the chosen model takes, when that is known; a saved level
  // it does not list still shows, so opening settings never changes a value.
  const efforts: readonly string[] = chosen?.efforts ?? EFFORTS;
  return (
    <div className="agent-fields">
      <label>
        Model
        <select
          aria-label="Model"
          disabled={disabled}
          value={value.model ?? ''}
          onChange={(e) => onChange({ ...value, model: e.target.value || null })}
        >
          <option value="">{inherited ? 'App default' : 'Claude Code default'}</option>
          {value.model && chosen === undefined && (
            <option value={value.model}>{value.model}</option>
          )}
          {offered.map((m) => (
            <option key={m.id} value={m.id} title={m.description ?? undefined}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Effort
        <select
          aria-label="Effort"
          disabled={disabled}
          value={value.effort ?? ''}
          onChange={(e) => onChange({ ...value, effort: e.target.value || null })}
        >
          <option value="">{inherited ? 'App default' : 'Agent default'}</option>
          {value.effort && !efforts.includes(value.effort) && (
            <option value={value.effort}>{value.effort}</option>
          )}
          {efforts.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </label>
      <label>
        Permissions
        <select
          aria-label="Permissions"
          disabled={disabled}
          value={value.permissionMode}
          onChange={(e) => onChange({ ...value, permissionMode: e.target.value as PermissionMode })}
        >
          {Object.entries(PERMISSIONS).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">
        Commands run with your host access. Worktrees are not a security sandbox. Bonsai owns
        branches and commits; ask for instructions for external changes.
      </p>
    </div>
  );
}
