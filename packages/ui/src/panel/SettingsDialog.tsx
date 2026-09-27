import { useEffect, useState, type JSX } from 'react';
import {
  ARCHIVE_AFTER_DAYS,
  CONCURRENCY,
  type AgentModel,
  TEXT_SCALES,
  type ConnectionStatus,
  type ProjectView,
  type SettingsView,
  type StorageView,
} from '@bonsai/shared';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import { bytes, plural } from '../words.ts';
import { Dialog, DialogHeader } from '../Dialog.tsx';
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
      <DialogHeader title="Settings" onClose={onClose} />
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
        <AppDefaults settings={settings} models={connection.models} onChanged={onChanged} />
        <Storage settings={settings} onChanged={onChanged} />
        <Locations settings={settings} onChanged={onChanged} />
      </div>
      <div hidden={tab !== 'project'} className="settings-sections">
        {project ? (
          <>
            <h4>Project settings — {project.name}</h4>
            <ProjectAgent
              key={`agent-${project.id}`}
              project={project}
              models={connection.models}
              onChanged={onChanged}
            />
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
  models,
  onChanged,
}: {
  settings: SettingsView;
  models: readonly AgentModel[] | undefined;
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
        models={models}
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
  models,
  onChanged,
}: {
  project: ProjectView;
  models: readonly AgentModel[] | undefined;
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
        models={models}
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
/**
 * Experiment folders, what they take up, and when an idle one is archived.
 * Measured when Settings opens, because it means walking every folder.
 */
function Storage({
  settings,
  onChanged,
}: {
  settings: SettingsView;
  onChanged: () => void;
}): JSX.Element {
  const [enabled, setEnabled] = useState(settings.archiveAfterDays !== null);
  const [days, setDays] = useState(settings.archiveAfterDays ?? ARCHIVE_AFTER_DAYS.default);
  const [use, setUse] = useState<StorageView | null>(null);
  const [useError, setUseError] = useState<string | null>(null);
  const save = useSave();
  useEffect(() => {
    let alive = true;
    api
      .storage()
      .then((view) => {
        if (alive) setUse(view);
      })
      .catch((e: unknown) => {
        if (alive) setUseError(describeError(e));
      });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <section className="settings-storage">
      <h4>Storage</h4>
      <p className="hint" role="status">
        {use === null
          ? (useError ?? 'Measuring experiment folders')
          : `${plural(use.folders, 'experiment folder')} on disk, ${bytes(use.bytes)} in all. ${plural(use.archived, 'experiment')} archived.`}
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={enabled}
          disabled={save.busy}
          onChange={(e) => {
            setEnabled(e.target.checked);
            save.reset();
          }}
        />
        <span>Archive the folders of experiments that sit idle</span>
      </label>
      <label>
        Idle for
        <span className="row">
          <input
            type="number"
            aria-label="Days idle before archiving"
            min={ARCHIVE_AFTER_DAYS.min}
            max={ARCHIVE_AFTER_DAYS.max}
            value={days}
            disabled={!enabled || save.busy}
            onChange={(e) => {
              setDays(Number(e.target.value));
              save.reset();
            }}
          />
          <span>days</span>
        </span>
      </label>
      <p className="hint">
        Archiving removes an experiment&rsquo;s folder and keeps its branch, conversation and runs.
        The next run brings the folder back and runs setup again. A folder with uncommitted work, or
        with ignored files other than dependencies and build output, is never archived on its own;
        archive it from its ⋯ menu instead.
      </p>
      <div className="save-row">
        <button
          disabled={save.busy}
          onClick={() =>
            void save.run(async () => {
              await api.updateSettings({ archiveAfterDays: enabled ? days : null });
              onChanged();
            })
          }
        >
          Save storage settings
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
              settings.hasStoredApiKey ? 'Leave empty to keep the stored key' : 'Paste your API key'
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
          aria-busy={action.busy}
          onClick={() =>
            void action.run(async () => {
              await api.checkConnection();
              onChanged();
            })
          }
        >
          Recheck
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
