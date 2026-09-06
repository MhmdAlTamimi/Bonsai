import { type JSX, useState } from 'react';
import { api } from '../api/client.ts';

/**
 * §6.1: name plus description. The app creates the repo, master branch and
 * worktree; D21 has the agent scaffold from the description, which starts
 * happening in M3.
 */
export function NewProject({ onCreated }: { onCreated: (id: string) => void }): JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { projectId } = await api.createProject({ name: name.trim() || 'untitled', description });
      onCreated(projectId);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="new-project">
      <h1>New project</h1>
      <p className="muted">
        Bonsai creates a repository, a master branch and a worktree. Nothing is imported and
        nothing touches your own copy of any code.
      </p>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name" aria-label="project name" />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="what should it build?"
        aria-label="project description"
        rows={4}
      />
      <button onClick={() => void create()} disabled={busy}>
        {busy ? 'Creating…' : 'Create project'}
      </button>
      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}
