import { type JSX, useState } from 'react';
import type { ProjectView } from '@bonsai/shared';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateProject(project.id, {
        copyFiles: files
          .split('\n')
          .map((f) => f.trim())
          .filter((f) => f !== ''),
        setupCommand: command.trim() === '' ? null : command.trim(),
      });
      setSaved(true);
      onChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h4>New nodes in {project.name}</h4>
      <p className="hint">
        A new node checks out tracked files only. These put back what git leaves behind.
      </p>
      <label className="stacked">
        Files to copy in, one per line
        <textarea
          value={files}
          onChange={(e) => setFiles(e.target.value)}
          placeholder=".env"
          aria-label="files to copy into each new node"
          rows={3}
          spellCheck={false}
        />
        <span className="hint">
          Copied, not linked. Tracked files are refused — they would be committed.
        </span>
      </label>
      <label className="stacked">
        Setup command
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="npm install"
          aria-label="setup command"
          spellCheck={false}
        />
        <span className="hint">Run once per node, before the agent starts.</span>
      </label>
      <div className="row">
        <button disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="hint">Saved. Applies to nodes created from now on.</span>}
      </div>
      {error !== null && <p className="error">{error}</p>}
    </section>
  );
}
