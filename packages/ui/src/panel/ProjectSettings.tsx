import { type JSX, useState } from 'react';
import { EFFORTS, type ProjectView } from '@bonsai/shared';
import { api } from '../api/client.ts';

/**
 * D32: model and effort are project-level settings.
 *
 * Surfaced rather than left to environment variables because they are the two
 * levers on what a run costs, and "why did that cost that much?" is not a
 * question you can answer from a canvas that never names the model.
 */
const MODELS: Array<{ id: string | null; label: string }> = [
  { id: null, label: 'SDK default' },
  { id: 'claude-opus-5', label: 'Opus 5 — most capable' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — cheapest' },
];

export function ProjectSettings({
  project,
  onChanged,
}: {
  project: ProjectView;
  onChanged: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);

  const update = async (patch: { model?: string | null; effort?: string | null }): Promise<void> => {
    setBusy(true);
    try {
      await api.updateProject(project.id, patch);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="project-settings">
      <span className="project-name">{project.name}</span>

      <label>
        model
        <select
          value={project.defaultModel ?? ''}
          disabled={busy}
          onChange={(e) => void update({ model: e.target.value === '' ? null : e.target.value })}
        >
          {MODELS.map((m) => (
            <option key={m.label} value={m.id ?? ''}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        effort
        <select
          value={project.defaultEffort ?? ''}
          disabled={busy}
          onChange={(e) => void update({ effort: e.target.value === '' ? null : e.target.value })}
        >
          <option value="">default</option>
          {EFFORTS.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </label>

      <span className="project-cost" title="Estimated at API list price across every run. Not a bill.">
        {project.costUsd > 0 ? `~$${project.costUsd.toFixed(3)}` : '—'}
      </span>
    </div>
  );
}
