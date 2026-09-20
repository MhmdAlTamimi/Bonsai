import { EFFORTS, type PermissionMode } from '@bonsai/shared';
import type { JSX } from 'react';
export const PERMISSIONS: Record<PermissionMode, string> = {
  acceptEdits: 'Allow tools and commands',
  default: 'Ask before changes',
  bypassPermissions: 'Bypass permission checks',
  plan: 'Plan (SDK mode)',
};
const MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];
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
}: {
  value: AgentValues;
  onChange: (value: AgentValues) => void;
  disabled: boolean;
  inherited?: boolean;
}): JSX.Element {
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
          {value.model && !MODELS.some((m) => m.id === value.model) && (
            <option value={value.model}>{value.model}</option>
          )}
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
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
          {EFFORTS.map((e) => (
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
