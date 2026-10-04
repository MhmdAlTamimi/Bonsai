import { useEffect, useState, type JSX } from 'react';
import type { LostExperimentView } from '@bonsai/shared';
import { IconButton } from '../Icon.tsx';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';

export function LostExperiments({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}): JSX.Element {
  const [items, setItems] = useState<LostExperimentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preserved, setPreserved] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    void api
      .lostExperiments(projectId)
      .then((items) => alive && setItems(items))
      .catch((error) => alive && setError(describeError(error)));
    return () => {
      alive = false;
    };
  }, [projectId, revision]);
  const recover = async (item: LostExperimentView): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.importLostExperiment(projectId, item.id, item.version);
      setPreserved(result.preservedPath);
      setRevision((value) => value + 1);
      onChanged();
    } catch (error) {
      setError(describeError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h4>Recover experiments from Git</h4>
      <p className="hint">
        Recover code missing from this database. Existing files are preserved first. Conversation
        history requires a newer database backup.
      </p>
      {error && <p role="alert">{error}</p>}
      {items === null ? (
        <p>Checking saved experiments…</p>
      ) : items.length === 0 ? (
        <p className="hint">No unrecorded experiments found.</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              {item.subject} · <code>{item.commit.slice(0, 10)}</code>{' '}
              {item.folder && <span>· folder preserved</span>}
              <button disabled={busy} onClick={() => void recover(item)}>
                Recover experiment
              </button>
            </li>
          ))}
        </ul>
      )}
      {preserved && (
        <p>
          Recovery copy: <code>{preserved}</code>
        </p>
      )}
      <IconButton
        icon="refresh"
        label="Refresh saved experiments"
        disabled={busy}
        onClick={() => {
          setError(null);
          setRevision((value) => value + 1);
        }}
      />
    </section>
  );
}
