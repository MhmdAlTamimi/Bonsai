import { type JSX, useState } from 'react';
import type { ConnectionStatus, SettingsView } from '@bonsai/shared';
import { api } from '../api/client.ts';
import { Logo } from '../Logo.tsx';

/**
 * Shown instead of the app whenever Bonsai cannot reach Claude.
 *
 * It blocks rather than degrading. Bonsai used to fall back to a stand-in
 * agent that wrote placeholder files, which was fine for someone reviewing the
 * code and actively misleading for someone using it: the app looked like it
 * worked and quietly did something else. There is no way to get past this
 * screen except by fixing the connection.
 */
export function ConnectionScreen({
  status,
  settings,
  onChanged,
}: {
  status: ConnectionStatus;
  settings: SettingsView | null;
  onChanged: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState<null | 'check' | 'login' | 'key'>(null);
  const [apiKey, setApiKey] = useState('');
  const [loginOutput, setLoginOutput] = useState<string | null>(null);

  const act = async (kind: 'check' | 'login' | 'key', fn: () => Promise<void>): Promise<void> => {
    setBusy(kind);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="connect">
      <h1>
        <Logo size={26} /> Connect Bonsai to Claude
      </h1>
      <Explanation status={status} />

      <section>
        <h2>Sign in with the Claude CLI</h2>
        <p className="muted">
          Uses your Claude subscription. Bonsai never sees or stores the credential.
        </p>
        <div className="row">
          <button
            disabled={busy !== null}
            onClick={() =>
              void act('login', async () => {
                const result = await api.login();
                setLoginOutput(result.output);
                onChanged();
              })
            }
          >
            {busy === 'login' ? 'Signing in…' : 'Run claude login'}
          </button>
          <button disabled={busy !== null} onClick={() => void act('check', async () => {
            await api.checkConnection();
            onChanged();
          })}>
            {busy === 'check' ? 'Checking…' : 'Recheck'}
          </button>
        </div>
        {loginOutput !== null && (
          <>
            <pre className="stream">{loginOutput}</pre>
            <p className="hint">
              Signing in is interactive, so it may need a real terminal. If nothing happened above,
              run <code>claude login</code> in a terminal and then press Recheck.
            </p>
          </>
        )}
      </section>

      <section>
        <h2>Or use an API key</h2>
        <p className="muted">
          Billed per token. Stored on this machine only, in a file readable just by you — never
          sent anywhere except to Anthropic.
        </p>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-ant-..."
          aria-label="API key"
        />
        <button
          disabled={busy !== null || apiKey.trim() === ''}
          onClick={() =>
            void act('key', async () => {
              await api.updateSettings({ authMode: 'api_key', apiKey: apiKey.trim() });
              setApiKey('');
              onChanged();
            })
          }
        >
          {busy === 'key' ? 'Saving…' : 'Save key and connect'}
        </button>
        {settings?.hasStoredApiKey === true && (
          <p className="hint">A key is already stored. Saving a new one replaces it.</p>
        )}
      </section>

      {settings !== null && (
        <p className="hint">
          Data lives in <code>{settings.dataDir}</code>
        </p>
      )}
    </div>
  );
}

function Explanation({ status }: { status: ConnectionStatus }): JSX.Element {
  switch (status.state) {
    case 'unknown':
      return <p className="muted">Checking the connection…</p>;
    case 'no_credential':
      return (
        <p className="muted">
          No working credential was found. Sign in below, or add an API key.
        </p>
      );
    case 'rate_limited':
      return (
        <>
          <p className="warn">
            Your credential works, but Claude is rate-limiting or you have hit a usage limit.
            Bonsai will work again once that clears.
          </p>
          {status.message !== null && <pre className="stream">{status.message}</pre>}
        </>
      );
    case 'error':
      return (
        <>
          <p className="warn">The connection check failed.</p>
          {status.message !== null && <pre className="stream">{status.message}</pre>}
        </>
      );
    case 'connected':
      return <p className="muted">Connected.</p>;
  }
}
