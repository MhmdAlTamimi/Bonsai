import { useCallback, useEffect, useState } from 'react';
import type { ConnectionStatus, SettingsView } from '@bonsai/shared';

import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';

const UNKNOWN: ConnectionStatus = {
  state: 'unknown',
  apiKeySource: null,
  model: null,
  message: null,
};

/**
 * Whether Bonsai can reach Claude, and the app's own settings.
 *
 * The two are one concern because they change together: every settings write
 * that touches authentication invalidates the connection, and the server
 * re-probes on exactly those writes. Splitting them would mean two hooks that
 * always have to be refreshed as a pair.
 */
export function useConnection(): {
  connection: ConnectionStatus;
  error: string | null;
  checking: boolean;
  settings: SettingsView | null;
  setSettings: (settings: SettingsView) => void;
  /** Re-reads both. Called after anything that could have changed either. */
  reload: () => void;
} {
  const [connection, setConnection] = useState<ConnectionStatus>(UNKNOWN);
  const [settings, setSettings] = useState<SettingsView | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 90_000;
    const load = async (): Promise<void> => {
      setChecking(true);
      setError(null);
      try {
        const [status, s] = await Promise.all([api.connection(), api.settings()]);
        if (!alive) return;
        setConnection(status);
        setSettings(s);
        if (status.state === 'unknown' && Date.now() < deadline)
          timer = setTimeout(() => void load(), 1500);
        else {
          setChecking(false);
          if (status.state === 'unknown')
            setError('Connection check timed out. Retry to check again.');
        }
      } catch (e) {
        if (alive) {
          setError(describeError(e));
          setChecking(false);
        }
      }
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [revision]);
  return {
    connection,
    settings,
    setSettings,
    error,
    checking,
    reload: useCallback(() => setRevision((n) => n + 1), []),
  };
}
