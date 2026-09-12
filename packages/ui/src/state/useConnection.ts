import { useCallback, useEffect, useState } from 'react';
import type { ConnectionStatus, SettingsView } from '@bonsai/shared';

import { api } from '../api/client.ts';

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
  settings: SettingsView | null;
  setSettings: (settings: SettingsView) => void;
  /** Re-reads both. Called after anything that could have changed either. */
  reload: () => void;
} {
  const [connection, setConnection] = useState<ConnectionStatus>(UNKNOWN);
  const [settings, setSettings] = useState<SettingsView | null>(null);

  const load = useCallback(async (): Promise<ConnectionStatus> => {
    const [status, s] = await Promise.all([api.connection(), api.settings()]);
    setConnection(status);
    setSettings(s);
    return status;
  }, []);

  useEffect(() => {
    void load().then((status) => {
      // The startup probe may still be running; poll until it settles rather
      // than showing "unknown" forever.
      if (status.state !== 'unknown') return;
      const timer = setInterval(() => {
        void load().then((next) => {
          if (next.state !== 'unknown') clearInterval(timer);
        });
      }, 1500);
      setTimeout(() => clearInterval(timer), 90_000);
    });
  }, [load]);

  return {
    connection,
    settings,
    setSettings,
    reload: useCallback(() => void load(), [load]),
  };
}
