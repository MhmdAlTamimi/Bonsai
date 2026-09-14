import { type JSX, useState } from 'react';
import type { ProjectView } from '@bonsai/shared';
import { api } from '../api/client.ts';
import { useSave } from './useSave.ts';
import { SaveFeedback } from './SaveFeedback.tsx';

/**
 * What a new node's folder needs before the agent arrives.
 *
 * Per project rather than per app: one project needs `uv sync`, the next needs
 * `npm install`, and a single global value would be wrong for every project
 * except the one it was typed for.
 */
export function NewNodeSetup({
  project,
  onChanged,
}: {
  project: ProjectView;
  onChanged: () => void;
}): JSX.Element {
  const [files, setFiles] = useState(project.setup.copyFiles.join('\n'));
  const [command, setCommand] = useState(project.setup.setupCommand ?? '');
  const feedback = useSave();
  const save = (): void => {
    void feedback.run(async () => {
      await api.updateProject(project.id, {
        copyFiles: files
          .split('\n')
          .map((f) => f.trim())
          .filter(Boolean),
        setupCommand: command.trim() || null,
      });
      onChanged();
    });
  };

  return (
    <section>
      <h4>Experiment setup</h4>
      <label className="stacked">
        Files to copy in, one per line
        <textarea
          value={files}
          disabled={feedback.busy}
          onChange={(e) => {
            setFiles(e.target.value);
            feedback.reset();
          }}
          placeholder="No extra files"
          aria-label="files to copy into each new node"
          rows={3}
          spellCheck={false}
        />
        <span className="hint">
          For new experiments. Listed files must exist and be gitignored.
        </span>
      </label>
      <label className="stacked">
        Setup command
        <input
          value={command}
          disabled={feedback.busy}
          onChange={(e) => {
            setCommand(e.target.value);
            feedback.reset();
          }}
          placeholder="npm install"
          aria-label="setup command"
          spellCheck={false}
        />
        <span className="hint">
          Used on the next run in experiments whose setup has not run yet.
        </span>
      </label>
      <div className="save-row">
        <button disabled={feedback.busy} onClick={save}>
          Save experiment setup
        </button>
        <SaveFeedback {...feedback} />
      </div>
    </section>
  );
}
