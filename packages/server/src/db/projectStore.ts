import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { PermissionMode } from '@bonsai/shared';

import { now, type ProjectRow } from './rows.js';

/**
 * Projects: the rows, their settings, and where their files live.
 *
 * One of five concern-sized stores behind the `Store` facade. It owns the
 * `project` table and nothing else — anything that needs a node, a run or a
 * message goes through the facade, which is the only place the concerns meet.
 */
export class ProjectStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly reposRoot: string,
    private readonly futureReposRoot?: () => string,
  ) {
    // Old projects used the configured root. Pin that location before accepting a
    // new preference; created projects already carry their actual repository path.
    for (const project of this.list()) {
      if (project.scratch_path !== null) continue;
      const scratch =
        project.source_kind === 'created'
          ? dirname(project.repo_path)
          : join(reposRoot, project.id);
      this.db.prepare('UPDATE project SET scratch_path = ? WHERE id = ?').run(scratch, project.id);
    }
  }

  create(input: {
    name: string;
    description: string;
    model: string | null;
    permissionMode: PermissionMode;
    effort?: string | null;
    /** Set when adopting a directory the user already had. */
    adopt?: { repoPath: string; sourcePath: string; protectedBranch: string };
  }): ProjectRow {
    const id = randomUUID();
    const scratch = join(this.futureReposRoot?.() ?? this.reposRoot, id);
    const row: ProjectRow = {
      id,
      name: input.name,
      description: input.description,
      repo_path: input.adopt?.repoPath ?? join(scratch, 'repo.git'),
      scratch_path: scratch,
      default_model: input.model,
      default_permission_mode: input.permissionMode,
      default_effort: input.effort ?? null,
      source_kind: input.adopt === undefined ? 'created' : 'adopted',
      source_path: input.adopt?.sourcePath ?? null,
      protected_branch: input.adopt?.protectedBranch ?? null,
      copy_files: JSON.stringify([]),
      setup_command: null,
      created_at: now(),
    };
    this.db
      .prepare(
        `INSERT INTO project (id, name, description, repo_path, default_model,
                              default_permission_mode, default_effort, source_kind,
                              source_path, protected_branch, copy_files, setup_command,
                              created_at, scratch_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.name,
        row.description,
        row.repo_path,
        row.default_model,
        row.default_permission_mode,
        row.default_effort,
        row.source_kind,
        row.source_path,
        row.protected_branch,
        row.copy_files,
        row.setup_command,
        row.created_at,
        row.scratch_path,
      );
    return row;
  }

  list(): ProjectRow[] {
    return this.db
      .prepare(`SELECT * FROM project ORDER BY created_at DESC`)
      .all() as unknown as ProjectRow[];
  }

  get(id: string): ProjectRow | undefined {
    return this.db.prepare(`SELECT * FROM project WHERE id = ?`).get(id) as unknown as
      ProjectRow | undefined;
  }

  /**
   * The directory Bonsai keeps a project's own files in: the bare repo for a
   * created project, the node worktrees for either kind. Always Bonsai's, never
   * the user's -- which is why deletion can remove it without asking.
   */
  scratchDir(projectId: string): string {
    return this.get(projectId)?.scratch_path ?? join(this.reposRoot, projectId);
  }

  /**
   * Records the folder that IS this project, as far as the user is concerned:
   * master's checkout. Set once, just after master exists, because for a
   * created project the default path contains master's own id.
   */
  setSourcePath(id: string, path: string): void {
    this.db.prepare(`UPDATE project SET source_path = ? WHERE id = ?`).run(path, id);
  }

  /** What a new node's worktree needs before the agent arrives. */
  updateSetup(
    id: string,
    patch: { copyFiles?: readonly string[]; setupCommand?: string | null },
  ): void {
    if (patch.copyFiles !== undefined) {
      this.db
        .prepare(`UPDATE project SET copy_files = ? WHERE id = ?`)
        .run(JSON.stringify(patch.copyFiles), id);
    }
    if (patch.setupCommand !== undefined) {
      const value = patch.setupCommand === null ? null : patch.setupCommand.trim();
      this.db
        .prepare(`UPDATE project SET setup_command = ? WHERE id = ?`)
        .run(value === '' ? null : value, id);
    }
  }

  /** D32: the model and effort a project's runs use. Changing them is not a
   *  node edit -- D3 constrains nodes, not settings. */
  updateSettings(
    id: string,
    patch: { model?: string | null; effort?: string | null; permissionMode?: PermissionMode },
  ): void {
    if (patch.permissionMode !== undefined)
      this.db
        .prepare('UPDATE project SET default_permission_mode = ? WHERE id = ?')
        .run(patch.permissionMode, id);
    if (patch.model !== undefined) {
      this.db.prepare(`UPDATE project SET default_model = ? WHERE id = ?`).run(patch.model, id);
    }
    if (patch.effort !== undefined) {
      this.db.prepare(`UPDATE project SET default_effort = ? WHERE id = ?`).run(patch.effort, id);
    }
  }

  /** Apply one settings form as one durable change. No async work inside. */
  saveConfiguration(
    id: string,
    patch: {
      model?: string | null;
      effort?: string | null;
      permissionMode?: PermissionMode;
      copyFiles?: readonly string[];
      setupCommand?: string | null;
    },
  ): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.updateSettings(id, patch);
      this.updateSetup(id, patch);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM project WHERE id = ?`).run(id);
  }
}
