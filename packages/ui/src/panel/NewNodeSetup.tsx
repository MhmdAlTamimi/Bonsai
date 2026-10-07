import { type JSX, useState } from 'react';
import type { ProjectView } from '@bonsai/shared';
import { api } from '../api/client.ts';
import { useSave } from './useSave.ts';
import { SaveFeedback } from './SaveFeedback.tsx';
import { useSettingsDraft } from './settingsDrafts.ts';

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
  const [rebuild, setRebuild] = useState((project.setup.rebuildPaths ?? []).join('\n'));
  const [conversion, setConversion] = useState<Awaited<
    ReturnType<typeof api.workspaceMigration>
  > | null>(null);
  const draft = useSettingsDraft({ files, command, rebuild });
  const feedback = useSave();
  const save = (): void => {
    void feedback.run(async () => {
      await api.updateProject(project.id, {
        copyFiles: files
          .split('\n')
          .map((f) => f.trim())
          .filter(Boolean),
        setupCommand: command.trim() || null,
        rebuildPaths: rebuild
          .split('\n')
          .map((path) => path.trim())
          .filter(Boolean),
      });
      draft.saved();
      onChanged();
    });
  };

  return (
    <section>
      <h4>Experiment setup</h4>
      <label className="stacked">
        Files to copy in, one per line
        <textarea
          value={files}
          disabled={feedback.busy}
          onChange={(e) => {
            setFiles(e.target.value);
            feedback.reset();
          }}
          placeholder="e.g. .env"
          aria-label="files to copy into each new experiment"
          rows={3}
          spellCheck={false}
        />
        <span className="hint">
          For new experiments. Listed files must exist and be gitignored.
        </span>
      </label>
      <label className="stacked">
        Setup command
        <input
          value={command}
          disabled={feedback.busy}
          onChange={(e) => {
            setCommand(e.target.value);
            feedback.reset();
          }}
          placeholder="e.g. npm install"
          aria-label="setup command"
          spellCheck={false}
        />
        <span className="hint">
          {project.workspace
            ? 'Runs when preparing an experiment’s environment.'
            : 'Runs before the first agent run in each folder.'}
        </span>
      </label>
      <label className="stacked">
        Regeneratable folders, one per line
        <textarea
          value={rebuild}
          disabled={feedback.busy}
          rows={3}
          spellCheck={false}
          aria-label="regeneratable folders"
          placeholder={'e.g. node_modules\n.venv\n.next'}
          onChange={(event) => {
            setRebuild(event.target.value);
            feedback.reset();
          }}
        />
        <span className="hint">
          Listed ignored folders may be deleted and rebuilt. Other local files are preserved per
          experiment.
        </span>
      </label>
      <div className="save-row">
        <button aria-label="Save experiment setup" disabled={feedback.busy} onClick={save}>
          Save
        </button>
        <SaveFeedback {...feedback} />
      </div>
      {project.workspace && (project.workspace.switching || project.workspace.recovering) && (
        <div role="status">
          <h4>Workspace recovery</h4>
          <p className="hint">
            Preparation was interrupted. Retry it, or preserve current files and restore the
            previous experiment.
          </p>
          <button
            disabled={feedback.busy}
            onClick={() => {
              void feedback.run(async () => {
                await api.recoverWorkspace(project.id, 'retry');
                onChanged();
              });
            }}
          >
            Retry preparation
          </button>
          <button
            disabled={feedback.busy}
            onClick={() => {
              void feedback.run(async () => {
                await api.recoverWorkspace(project.id, 'restore');
                onChanged();
              });
            }}
          >
            Preserve files and restore
          </button>
        </div>
      )}
      {project.workspace?.recoveryCopy && (
        <p className="hint">Recovery copy: {project.workspace.recoveryCopy}</p>
      )}
      {(!project.workspace || project.workspaceConversionPending) && (
        <div className="workspace-conversion">
          <h4>Shared workspace</h4>
          <p className="hint">One working folder per project. Experiments run one at a time.</p>
          <button
            disabled={feedback.busy}
            onClick={() => {
              void feedback.run(async () => {
                // Save this form before preflight so conversion uses exactly the displayed cleanup policy.
                if (!project.workspaceConversionPending)
                  await api.updateProject(project.id, {
                    copyFiles: files
                      .split('\n')
                      .map((path) => path.trim())
                      .filter(Boolean),
                    setupCommand: command.trim() || null,
                    rebuildPaths: rebuild
                      .split('\n')
                      .map((path) => path.trim())
                      .filter(Boolean),
                  });
                draft.saved();
                setConversion(await api.workspaceMigration(project.id));
                onChanged();
              });
            }}
          >
            Review conversion
          </button>
          {conversion && (
            <div role="status">
              {conversion.blocked.length ? (
                <p>{conversion.blocked.join(' ')}</p>
              ) : (
                <>
                  <p>
                    {conversion.folders} working folders · {conversion.preservedFiles} local paths
                    preserved. Saved code and conversations stay.
                  </p>
                  <button
                    disabled={feedback.busy}
                    onClick={() => {
                      void feedback.run(async () => {
                        await api.migrateWorkspace(project.id, conversion.version);
                        setConversion(null);
                        onChanged();
                      });
                    }}
                  >
                    {conversion.pending ? 'Resume conversion' : 'Convert workspace'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
