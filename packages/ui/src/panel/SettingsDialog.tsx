import { useEffect, useRef, useState, type JSX } from 'react';
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
import { IconButton } from '../Icon.tsx';
import { CopyButton } from '../CopyButton.tsx';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import { bytes, plural } from '../words.ts';
import { Dialog, DialogHeader } from '../Dialog.tsx';
import { NewNodeSetup } from './NewNodeSetup.tsx';
import { Diagnostics } from './Diagnostics.tsx';
import { AgentFields, type AgentValues } from './AgentFields.tsx';
import { useSave } from './useSave.ts';
import { SaveFeedback } from './SaveFeedback.tsx';
import { LostExperiments } from './LostExperiments.tsx';
import { SettingsDrafts, useSettingsDraft } from './settingsDrafts.ts';
import type { ConfirmRequest } from '../ConfirmDialog.tsx';

export function SettingsDialog({
  settings,
  connection,
  project,
  selectedNodeId,
  onClose,
  onChanged,
  confirm,
  initialTab = 'app',
}: {
  settings: SettingsView;
  connection: ConnectionStatus;
  project: ProjectView | null;
  selectedNodeId: string | null;
  onClose: () => void;
  onChanged: () => void;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  initialTab?: 'app' | 'project';
}): JSX.Element {
  const [tab, setTab] = useState<'app' | 'project' | 'diagnostics'>(initialTab);
  const drafts = useRef(new Set<symbol>()).current;
  const closing = useRef(false);
  const close = (): void => {
    if (closing.current) return;
    if (drafts.size === 0) {
      onClose();
      return;
    }
    closing.current = true;
    void confirm({
      title: 'Discard unsaved settings?',
      body: ['Close Settings and lose your unsaved edits?'],
      confirmLabel: 'Discard edits',
    })
      .then((discard) => {
        if (discard) onClose();
      })
      .finally(() => {
        closing.current = false;
      });
  };
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent): void => {
      if (drafts.size === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [drafts]);
  return (
    <SettingsDrafts.Provider value={drafts}>
      <Dialog title="Settings" className="wide settings-dialog" onClose={close}>
        <DialogHeader title="Settings" onClose={close} />
        <nav className="settings-tabs" aria-label="Settings scope">
          {(['app', 'project', 'diagnostics'] as const).map((scope) => (
            <button
              key={scope}
              aria-label={
                scope === 'app'
                  ? 'App settings'
                  : scope === 'project'
                    ? 'Project settings'
                    : 'Diagnostics'
              }
              aria-pressed={tab === scope}
              onClick={() => setTab(scope)}
            >
              {scope === 'app' ? 'App' : scope === 'project' ? 'Project' : 'Diagnostics'}
            </button>
          ))}
        </nav>
        <div hidden={tab !== 'app'} className="settings-sections">
          <ConnectionSettings settings={settings} connection={connection} onChanged={onChanged} />
          <Appearance settings={settings} onChanged={onChanged} />
          <AppDefaults settings={settings} models={connection.models} onChanged={onChanged} />
          <Storage settings={settings} onChanged={onChanged} confirm={confirm} />
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
              <LostExperiments
                key={`lost-${project.id}`}
                projectId={project.id}
                onChanged={onChanged}
              />
            </>
          ) : (
            <p className="muted">Open a project to change its settings.</p>
          )}
        </div>
        <div hidden={tab !== 'diagnostics'}>
          <Diagnostics key={selectedNodeId} nodeId={selectedNodeId} />
        </div>
      </Dialog>
    </SettingsDrafts.Provider>
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
  const draft = useSettingsDraft({ value, limit });
  const save = useSave();
  return (
    <section className="app-defaults">
      <h4>Agent defaults</h4>
      <p className="hint">Used by new projects and those set to App default.</p>
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
      <p className="hint">Across all projects. Active runs keep running.</p>
      <div className="save-row">
        <button
          aria-label="Save app defaults"
          disabled={save.busy}
          onClick={() =>
            void save.run(async () => {
              await api.updateSettings({ ...value, maxConcurrentRuns: limit });
              draft.saved();
              onChanged();
            })
          }
        >
          Save
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
  const draft = useSettingsDraft(value);
  return (
    <section className="project-agent">
      <h4>Agent for this project</h4>
      <p className="hint">Applies to the next run, including queued work.</p>
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
          aria-label="Save project agent"
          disabled={save.busy}
          onClick={() =>
            void save.run(async () => {
              await api.updateProject(project.id, value);
              draft.saved();
              onChanged();
            })
          }
        >
          Save
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
  confirm,
}: {
  settings: SettingsView;
  onChanged: () => void;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
}): JSX.Element {
  const [enabled, setEnabled] = useState(settings.archiveAfterDays !== null);
  const [days, setDays] = useState(settings.archiveAfterDays ?? ARCHIVE_AFTER_DAYS.default);
  const draft = useSettingsDraft({ enabled, days });
  const [use, setUse] = useState<StorageView | null>(null);
  const [storageRevision, setStorageRevision] = useState(0);
  const cleanup = useSave();
  const [useError, setUseError] = useState<string | null>(null);
  const [backupPath, setBackupPath] = useState<string | null>(null);
  const [backupFallbacks, setBackupFallbacks] = useState(0);
  const backup = useSave();
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
  }, [storageRevision]);
  return (
    <section className="settings-storage">
      <h4>Storage</h4>
      <p className="hint" role="status">
        {use === null
          ? (useError ?? 'Measuring experiment folders')
          : `${plural(use.folders, 'experiment folder')} on disk · ${plural(use.archived, 'experiment')} archived.`}
      </p>
      {use !== null && (
        <>
          <dl className="storage-metrics">
            <div>
              <dt>Experiments</dt>
              <dd>{bytes(use.bytes)}</dd>
            </div>
            <div>
              <dt>Comparisons</dt>
              <dd>{bytes(use.comparisonBytes)}</dd>
            </div>
            <div>
              <dt>Attachments</dt>
              <dd>{bytes(use.attachmentBytes)}</dd>
            </div>
          </dl>
          <details className="help-details">
            <summary>What uses space?</summary>
            <p>
              These totals exclude Git history, databases and backups. Comparisons keep their own
              code copies, even after an experiment is deleted. Run attachments stay with their
              experiment.
            </p>
          </details>
          <details className="storage-comparisons help-details">
            <summary>Manage comparisons</summary>
            {use.projects.every((project) => project.comparisons.length === 0) && (
              <p>No saved comparisons.</p>
            )}
            {use.projects
              .filter((project) => project.comparisonBytes > 0 || project.attachmentBytes > 0)
              .map((project) => (
                <div key={project.id} className="storage-project">
                  <h4>{project.name}</h4>
                  <p className="hint">
                    Comparisons: {bytes(project.comparisonBytes)} · Run attachments:{' '}
                    {bytes(project.attachmentBytes)}
                  </p>
                  {project.comparisons.map((comparison) => (
                    <div className="storage-comparison" key={comparison.id}>
                      <span>
                        {comparison.title} · {bytes(comparison.bytes)}
                        {comparison.hasDeletedSources ? ' · Includes deleted experiments' : ''}
                      </span>
                      <IconButton
                        icon="trash"
                        label={`Delete comparison ${comparison.title}`}
                        tone="danger"
                        disabled={cleanup.busy}
                        onClick={() =>
                          void cleanup.run(async () => {
                            const ok = await confirm({
                              title: `Delete comparison “${comparison.title}”?`,
                              body: [
                                'Permanently delete its saved code and conversation? Original experiments are kept.',
                                ...(comparison.hasDeletedSources
                                  ? [
                                      'Some original experiments were deleted. This may be the only remaining code copy. Back it up first.',
                                    ]
                                  : []),
                              ],
                              confirmLabel: 'Delete comparison',
                              danger: true,
                            });
                            if (!ok) return;
                            await api.deleteComparison(comparison.id);
                            setStorageRevision((value) => value + 1);
                            onChanged();
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              ))}
            <SaveFeedback {...cleanup} />
          </details>
        </>
      )}
      <h5>Backup</h5>
      <p className="hint">Finish or stop active runs before backing up.</p>
      <details className="help-details">
        <summary>What’s included?</summary>
        <p>
          Conversations, Git history, comparisons and experiment files, including ignored files.
          Claude sign-in and API keys are excluded. Changes pause during backup.
        </p>
      </details>
      <div className="save-row">
        <button
          disabled={backup.busy}
          onClick={() =>
            void backup.run(async () => {
              setBackupPath(null);
              const result = await api.backup();
              setBackupPath(result.path);
              setBackupFallbacks(result.conversationFallbacks);
            })
          }
        >
          {backup.busy ? 'Making backup…' : 'Make backup'}
        </button>
        <SaveFeedback {...backup} />
      </div>
      {backupPath !== null && (
        <div className="backup-result" role="status">
          <p className="hint">Backup verified. Keep a copy on another drive.</p>
          <div className="row">
            <code className="path-value">{backupPath}</code>
            <CopyButton text={backupPath} label="Copy backup folder" />
          </div>
          <details className="help-details">
            <summary>Restore a backup</summary>
            <ol>
              <li>Close Bonsai.</li>
              <li>Use this backup as your data folder.</li>
              <li>Start Bonsai and sign in again.</li>
            </ol>
          </details>
        </div>
      )}
      {backupPath !== null && backupFallbacks > 0 && (
        <p className="hint" role="status">
          {plural(backupFallbacks, 'original Claude conversation')} unavailable. Saved messages are
          backed up. Resuming will rebuild context and may shorten older content.
        </p>
      )}
      <h5>Auto-archive</h5>
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
        <span>Auto-archive idle experiments</span>
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
        Removes idle folders; keeps saved code and conversations. The next run restores the folder
        and reruns setup.
      </p>
      <details className="help-details">
        <summary>Archive rules</summary>
        <p>
          Folders with uncommitted work or ignored files other than dependencies and build output
          are skipped. Manual archiving is in the experiment’s menu.
        </p>
      </details>
      <div className="save-row">
        <button
          aria-label="Save storage settings"
          disabled={save.busy}
          onClick={() =>
            void save.run(async () => {
              await api.updateSettings({ archiveAfterDays: enabled ? days : null });
              draft.saved();
              onChanged();
            })
          }
        >
          Save
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
  const draft = useSettingsDraft(root);
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
      <p className="hint">New repositories only. Existing folders stay in place.</p>
      <div className="save-row">
        <button
          aria-label="Save location"
          disabled={save.busy}
          onClick={() =>
            void save.run(async () => {
              await api.updateSettings({ reposRoot: root });
              draft.saved();
              onChanged();
            })
          }
        >
          Save
        </button>
        <IconButton
          icon="folderOpen"
          label="Open saved location"
          onClick={() =>
            void reveal.run(async () => {
              await api.revealStorage();
            })
          }
        />
        <SaveFeedback {...save} />
      </div>
      <p className="hint">App data folder</p>
      <div className="row path-row">
        <code className="path-value">{settings.dataDir}</code>
        <IconButton
          icon="folderOpen"
          label="Open app data folder"
          onClick={() =>
            void reveal.run(async () => {
              await api.reveal(settings.dataDir);
            })
          }
        />
      </div>
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
  const draft = useSettingsDraft({ mode, key });
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
          aria-label="Save connection"
          disabled={save.busy}
          onClick={() =>
            void save.run(async () => {
              await api.updateSettings({
                authMode: mode,
                ...(key.trim() ? { apiKey: key.trim() } : {}),
              });
              setKey('');
              draft.saved({ mode, key: '' });
              onChanged();
            })
          }
        >
          Save
        </button>
        <SaveFeedback {...save} />
      </div>
      {mode === 'cli' && (
        <>
          <p className="hint">Follow the sign-in prompt, then recheck your connection.</p>
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
        <IconButton
          icon="refresh"
          label="Recheck"
          disabled={action.busy}
          aria-busy={action.busy}
          onClick={() =>
            void action.run(async () => {
              await api.checkConnection();
              onChanged();
            })
          }
        />
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
  const draft = useSettingsDraft(scale);
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
          aria-label="Save appearance"
          disabled={save.busy}
          onClick={() =>
            void save.run(async () => {
              await api.updateSettings({ textScale: scale });
              draft.saved();
              onChanged();
            })
          }
        >
          Save
        </button>
        <SaveFeedback {...save} />
      </div>
    </section>
  );
}
