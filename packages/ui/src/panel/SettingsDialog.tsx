import { type JSX, useState } from 'react';
import { EFFORTS, type ConnectionStatus, type SettingsView } from '@bonsai/shared';
import { api } from '../api/client.ts';

const MODELS: Array<{ id: string | null; label: string }> = [
  { id: null, label: 'Claude Code default' },
  { id: 'claude-opus-5', label: 'Opus 5 — most capable' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — cheapest' },
];

const PERMISSION_MODES = [
  { id: 'acceptEdits', label: 'Accept edits (recommended)' },
  { id: 'bypassPermissions', label: 'Bypass all permission checks' },
  { id: 'plan', label: 'Plan only — never edits' },
] as const;

/** Agent settings and locations. D32 makes model and permission mode settings. */
export function SettingsDialog({
  settings,
  connection,
  onClose,
  onChanged,
}: {
  settings: SettingsView;
  connection: ConnectionStatus;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [reposRoot, setReposRoot] = useState(settings.reposRoot);
  const [note, setNote] = useState<string | null>(null);

  const save = async (patch: Parameters<typeof api.updateSettings>[0]): Promise<void> => {
    setBusy(true);
    try {
      await api.updateSettings(patch);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog wide" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>Settings</h3>
          <button className="dialog-close" onClick={onClose} aria-label="close">×</button>
        </header>

        <section>
          <h4>Connection</h4>
          <div className={`conn-row conn-${connection.state}`}>
            <span className="conn-dot" />
            <span>
              {connection.state === 'connected'
                ? `Connected · ${connection.apiKeySource === 'none' ? 'Claude subscription' : 'API key'} · ${connection.model ?? ''}`
                : connection.state.replace('_', ' ')}
            </span>
            <button
              disabled={busy}
              onClick={() => void (async () => {
                setBusy(true);
                try { await api.checkConnection(); onChanged(); } finally { setBusy(false); }
              })()}
            >
              Recheck
            </button>
          </div>
          {connection.message !== null && <pre className="stream">{connection.message}</pre>}

          <label>
            Sign in with
            <select
              value={settings.authMode}
              disabled={busy}
              onChange={(e) => void save({ authMode: e.target.value as 'cli' | 'api_key' })}
            >
              <option value="cli">Claude subscription (claude auth login)</option>
              <option value="api_key">API key</option>
            </select>
          </label>

          {settings.authMode === 'cli' ? (
            <div className="row">
              <button
                disabled={busy}
                onClick={() => void (async () => {
                  setBusy(true);
                  try {
                    const r = await api.login();
                    setNote(r.output);
                    onChanged();
                  } finally { setBusy(false); }
                })()}
              >
                Sign in
              </button>
              <span className="hint">Bonsai never sees or stores this credential.</span>
            </div>
          ) : (
            <>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={settings.hasStoredApiKey ? 'a key is stored — type to replace' : 'sk-ant-...'}
                aria-label="API key"
              />
              <div className="row">
                <button disabled={busy || apiKey.trim() === ''} onClick={() => void save({ apiKey: apiKey.trim() }).then(() => setApiKey(''))}>
                  Save key
                </button>
                {settings.hasStoredApiKey && (
                  <button disabled={busy} onClick={() => void save({ apiKey: '' })}>Remove key</button>
                )}
              </div>
              <p className="hint">Stored on this machine only, in a file readable just by you.</p>
            </>
          )}
          {note !== null && <pre className="stream">{note}</pre>}
        </section>

        <section>
          <h4>Agent</h4>
          <label>
            Model
            <select
              value={settings.model ?? ''}
              disabled={busy}
              onChange={(e) => void save({ model: e.target.value === '' ? null : e.target.value })}
            >
              {MODELS.map((m) => <option key={m.label} value={m.id ?? ''}>{m.label}</option>)}
            </select>
          </label>
          <label>
            Effort
            <select
              value={settings.effort ?? ''}
              disabled={busy}
              onChange={(e) => void save({ effort: e.target.value === '' ? null : e.target.value })}
            >
              <option value="">default</option>
              {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
          <label>
            Permission mode
            <select
              value={settings.permissionMode}
              disabled={busy}
              onChange={(e) => void save({ permissionMode: e.target.value as SettingsView['permissionMode'] })}
            >
              {PERMISSION_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <p className="hint">
            Applies to projects created from now on; existing projects keep what they were made
            with. Lower effort and a cheaper model both reduce what a run costs.
          </p>
        </section>

        <section>
          <h4>Locations</h4>
          <label className="stacked">
            Projects folder
            <div className="row">
              <input value={reposRoot} onChange={(e) => setReposRoot(e.target.value)} aria-label="projects folder" />
              <button disabled={busy || reposRoot === settings.reposRoot} onClick={() => void save({ reposRoot })}>
                Save
              </button>
              <button disabled={busy} onClick={() => void api.reveal(settings.reposRoot)}>Reveal</button>
            </div>
          </label>
          <p className="hint">
            Only affects <strong>new</strong> projects. Existing ones cannot be moved by changing
            this: git records absolute paths in each worktree, so relocating a project needs
            <code>git worktree repair</code> and is not something to do silently.
          </p>
          <label className="stacked">
            Data folder
            <div className="row">
              <input value={settings.dataDir} readOnly aria-label="data folder" />
              <button disabled={busy} onClick={() => void api.reveal(settings.dataDir)}>Reveal</button>
            </div>
          </label>
        </section>
      </div>
    </div>
  );
}
