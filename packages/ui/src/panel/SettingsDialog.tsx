import { useState, type JSX } from 'react';
import {
  CONCURRENCY,
  TEXT_SCALES,
  type ConnectionStatus,
  type ProjectView,
  type SettingsView,
} from '@bonsai/shared';
import { Icon } from '../Icon.tsx';
import { api } from '../api/client.ts';
import { Dialog } from '../Dialog.tsx';
import { NewNodeSetup } from './NewNodeSetup.tsx';
import { Diagnostics } from './Diagnostics.tsx';
import { AgentFields, type AgentValues } from './AgentFields.tsx';
import { useSave } from './useSave.ts';
import { SaveFeedback } from './SaveFeedback.tsx';

export function SettingsDialog({
  settings,
  connection,
  project,
  selectedNodeId,
  onClose,
  onChanged,
  initialTab = 'app',
}: {
  settings: SettingsView;
  connection: ConnectionStatus;
  project: ProjectView | null;
  selectedNodeId: string | null;
  onClose: () => void;
  onChanged: () => void;
  initialTab?: 'app' | 'project';
}): JSX.Element {
  const [tab, setTab] = useState<'app' | 'project' | 'diagnostics'>(initialTab);
  return (
    <Dialog title="Settings" className="wide settings-dialog" onClose={onClose}>
      <header>
        <h3>Settings</h3>
        <button onClick={onClose} className="dialog-close" aria-label="Close settings">
          <Icon name="close" />
        </button>
      </header>
      <nav className="settings-tabs" aria-label="Settings scope">
        {(['app', 'project', 'diagnostics'] as const).map((scope) => (
          <button key={scope} aria-pressed={tab === scope} onClick={() => setTab(scope)}>
            {scope === 'app'
              ? 'App settings'
              : scope === 'project'
                ? 'Project settings'
                : 'Diagnostics'}
          </button>
        ))}
      </nav>
      <div hidden={tab !== 'app'} className="settings-sections">
        <ConnectionSettings settings={settings} connection={connection} onChanged={onChanged} />
        <Appearance settings={settings} onChanged={onChanged} />
        <AppDefaults settings={settings} onChanged={onChanged} />
        <Locations settings={settings} onChanged={onChanged} />
      </div>
      <div hidden={tab !== 'project'} className="settings-sections">
        {project ? (
          <>
            <h4>Project settings — {project.name}</h4>
            <ProjectAgent key={`agent-${project.id}`} project={project} onChanged={onChanged} />
            <NewNodeSetup key={`setup-${project.id}`} project={project} onChanged={onChanged} />
          </>
        ) : (
          <p className="muted">Open a project to change its settings.</p>
        )}
      </div>
      <div hidden={tab !== 'diagnostics'}>
        <Diagnostics key={selectedNodeId} nodeId={selectedNodeId} />
      </div>
    </Dialog>
  );
}

function AppDefaults({
  settings,
  onChanged,
}: {
  settings: SettingsView;
  onChanged: () => void;
}): JSX.Element {
  const [value, setValue] = useState<AgentValues>({
    model: settings.model,
    effort: settings.effort,
    permissionMode: settings.permissionMode,
  });
  const [limit, setLimit] = useState(settings.maxConcurrentRuns);
  const save = useSave();
  return (
    <section className="app-defaults">
      <h4>Agent defaults</h4>
      <p className="hint">
        New projects start with these values. Projects using App default follow later model and
        effort changes.
      </p>
      <AgentFields
        value={value}
        disabled={save.busy}
        onChange={(next) => {
          setValue(next);
          save.reset();
        }}
      />
      <label>
        Concurrent runs
        <select
          aria-label="Concurrent runs"
          value={limit}
          disabled={save.busy}
          onChange={(e) => {
            setLimit(Number(e.target.value));
            save.reset();
          }}
        >
          {Array.from({ length: CONCURRENCY.max }, (_, i) => (
            <option value={i + 1} key={i}>
              {i + 1}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">
        Applies to scheduling across all projects. Active runs finish normally.
      </p>
      <div className="save-row">
        <button
          disabled={save.busy}
          onClick={() =>
            void save.run(async () => {
              await api.updateSettings({ ...value, maxConcurrentRuns: limit });
              onChanged();
            })
          }
        >
          Save app defaults
        </button>
        <SaveFeedback {...save} />
      </div>
    </section>
  );
}
function ProjectAgent({
  project,
  onChanged,
}: {
  project: ProjectView;
  onChanged: () => void;
}): JSX.Element {
  const [value, setValue] = useState<AgentValues>({
    model: project.defaultModel,
    effort: project.defaultEffort,
    permissionMode: project.defaultPermissionMode,
  });
  const save = useSave();
  return (
    <section className="project-agent">
      <h4>Agent for this project</h4>
      <p className="hint">
        Applies when a run begins, including queued runs. Already running agents keep their
        settings.
      </p>
      <AgentFields
        inherited
        value={value}
        disabled={save.busy}
        onChange={(next) => {
          setValue(next);
          save.reset();
        }}
      />
      <div className="save-row">
        <button
          disabled={save.busy}
          onClick={() =>
            void save.run(async () => {
              await api.updateProject(project.id, value);
              onChanged();
            })
          }
        >
          Save project agent
        </button>
        <SaveFeedback {...save} />
      </div>
    </section>
  );
}
function Locations({
  settings,
  onChanged,
}: {
  settings: SettingsView;
  onChanged: () => void;
}): JSX.Element {
  const [root, setRoot] = useState(settings.reposRoot);
  const save = useSave();
  const reveal = useSave();
  return (
    <section className="settings-locations">
      <h4>Locations</h4>
      <label className="stacked">
        Managed repositories folder
        <input
          aria-label="Managed repositories folder"
          value={root}
          disabled={save.busy}
          onChange={(e) => {
            setRoot(e.target.value);
            save.reset();
          }}
        />
      </label>
      <p className="hint">
        Storage for future managed repositories. Existing folders stay in place.
      </p>
      <div className="save-row">
        <button
          disabled={save.busy}
          onClick={() =>
            void save.run(async () => {
              await api.updateSettings({ reposRoot: root });
              onChanged();
            })
          }
        >
          Save location
        </button>
        <button
          onClick={() =>
            void reveal.run(async () => {
              await api.reveal(settings.reposRoot);
            })
          }
        >
          Open saved location
        </button>
        <SaveFeedback {...save} />
      </div>
      <label className="stacked">
        App data folder<code>{settings.dataDir}</code>
      </label>
      <button
        onClick={() =>
          void reveal.run(async () => {
            await api.reveal(settings.dataDir);
          })
        }
      >
        Open app data folder
      </button>
      {reveal.error && (
        <p className="error" role="alert">
          {reveal.error}
        </p>
      )}
    </section>
  );
}
function ConnectionSettings({
  settings,
  connection,
  onChanged,
}: {
  settings: SettingsView;
  connection: ConnectionStatus;
  onChanged: () => void;
}): JSX.Element {
  const [mode, setMode] = useState(settings.authMode);
  const [key, setKey] = useState('');
  const [output, setOutput] = useState<string | null>(null);
  const save = useSave();
  const action = useSave();
  return (
    <details className="connection-settings" open={connection.state !== 'connected' || undefined}>
      <summary>
        Agent connection ·{' '}
        {connection.state === 'connected' ? 'Connected' : connection.state.replaceAll('_', ' ')}
      </summary>
      {connection.message && <pre className="stream">{connection.message}</pre>}
      <label>
        Sign in with
        <select
          aria-label="Sign in with"
          value={mode}
          disabled={save.busy}
          onChange={(e) => {
            setMode(e.target.value as 'cli' | 'api_key');
            save.reset();
          }}
        >
          <option value="cli">Claude subscription</option>
          <option value="api_key">API key</option>
        </select>
      </label>
      {mode === 'api_key' && (
        <label className="stacked">
          API key
          <input
            type="password"
            aria-label="API key"
            value={key}
            disabled={save.busy}
            placeholder={
              settings.hasStoredApiKey ? 'Leave blank to keep the stored key' : 'Enter API key'
            }
            onChange={(e) => {
              setKey(e.target.value);
              save.reset();
            }}
          />
        </label>
      )}
      <div className="save-row">
        <button
          disabled={save.busy}
          onClick={() =>
            void save.run(async () => {
              await api.updateSettings({
                authMode: mode,
                ...(key.trim() ? { apiKey: key.trim() } : {}),
              });
              setKey('');
              onChanged();
            })
          }
        >
          Save connection
        </button>
        <SaveFeedback {...save} />
      </div>
      {mode === 'cli' && (
        <>
          <p className="hint">
            Sign-in may open a browser. If a terminal is needed, run{' '}
            <code>claude auth login --claudeai</code>, then Recheck.
          </p>
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const result = await api.login();
                setOutput(result.output);
                onChanged();
              })
            }
          >
            Sign in
          </button>
        </>
      )}
      <div className="row">
        <button
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              await api.checkConnection();
              onChanged();
            })
          }
        >
          {action.busy ? 'Checking…' : 'Recheck'}
        </button>
        {settings.hasStoredApiKey && (
          <button
            disabled={save.busy}
            onClick={() =>
              void save.run(async () => {
                await api.updateSettings({ apiKey: '' });
                onChanged();
              })
            }
          >
            Remove stored key
          </button>
        )}
      </div>
      {action.error && (
        <p className="error" role="alert">
          {action.error}
        </p>
      )}
      {output && <pre className="stream">{output}</pre>}
    </details>
  );
}

function Appearance({
  settings,
  onChanged,
}: {
  settings: SettingsView;
  onChanged: () => void;
}): JSX.Element {
  const [scale, setScale] = useState(settings.textScale);
  const save = useSave();
  return (
    <section className="appearance-settings">
      <h4>Appearance</h4>
      <label>
        Text size
        <select
          aria-label="Text size"
          value={scale}
          disabled={save.busy}
          onChange={(e) => {
            setScale(Number(e.target.value));
            save.reset();
          }}
        >
          {TEXT_SCALES.map((value) => (
            <option key={value} value={value}>
              {value === 100 ? 'Standard' : value === 115 ? 'Large' : 'Larger'} · {value}%
            </option>
          ))}
        </select>
      </label>
      <div className="save-row">
        <button
          disabled={save.busy}
          onClick={() =>
            void save.run(async () => {
              await api.updateSettings({ textScale: scale });
              onChanged();
            })
          }
        >
          Save appearance
        </button>
        <SaveFeedback {...save} />
      </div>
    </section>
  );
}
