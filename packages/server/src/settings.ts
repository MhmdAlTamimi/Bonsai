import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PANEL_WIDTH,
  type PermissionMode,
  type SettingsView,
  type UpdateSettingsRequest,
} from '@bonsai/shared';

import type { Config } from './config.js';

interface StoredSettings {
  authMode: 'cli' | 'api_key';
  apiKey: string | null;
  model: string | null;
  permissionMode: PermissionMode;
  effort: string | null;
  reposRoot: string | null;
  panelWidth: number;
}

const DEFAULTS: StoredSettings = {
  authMode: 'cli',
  apiKey: null,
  model: null,
  permissionMode: 'acceptEdits',
  effort: null,
  reposRoot: null,
  panelWidth: PANEL_WIDTH.default,
};

/*
 * Clamped on the server as well as in the drag handler, because the stored
 * value outlives the session that produced it: a bad number written once would
 * come back on every launch. Bounds live in the contract so the two ends
 * cannot drift apart.
 */

/**
 * Bonsai's own settings, kept in a file rather than the database.
 *
 * The API key is the reason. It does not belong in a SQLite file that gets
 * copied around, backed up by the migration runner, or opened by anyone
 * debugging a tree — so settings live in their own file, written 0600, and the
 * key is NEVER sent to the UI: the client is told only whether one is stored.
 *
 * Using `claude login` instead keeps the credential entirely out of Bonsai's
 * hands, which is why that is the default.
 */
export class Settings {
  private readonly file: string;
  private current: StoredSettings;

  constructor(private readonly config: Config) {
    mkdirSync(config.dataDir, { recursive: true });
    this.file = join(config.dataDir, 'settings.json');
    this.current = this.read();
  }

  private read(): StoredSettings {
    if (!existsSync(this.file)) return { ...DEFAULTS };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoredSettings>;
      return { ...DEFAULTS, ...parsed };
    } catch {
      // A corrupt settings file must not stop the app starting; defaults are
      // always usable, and the next save rewrites it.
      return { ...DEFAULTS };
    }
  }

  private write(): void {
    writeFileSync(this.file, JSON.stringify(this.current, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // Windows has no POSIX mode; the file inherits the user's ACL.
    }
  }

  /** Environment variables that make a stored key visible to the Agent SDK. */
  agentEnv(): Record<string, string> | null {
    if (this.current.authMode !== 'api_key' || this.current.apiKey === null) return null;
    return { ANTHROPIC_API_KEY: this.current.apiKey };
  }

  apiKey(): string | null {
    return this.current.authMode === 'api_key' ? this.current.apiKey : null;
  }

  model(): string | null {
    return this.current.model;
  }

  permissionMode(): PermissionMode {
    return this.current.permissionMode;
  }

  effort(): string | null {
    return this.current.effort;
  }

  panelWidth(): number {
    return clampPanel(this.current.panelWidth);
  }

  /** Where new projects are created. Existing ones keep the path they were made with. */
  reposRoot(): string {
    return this.current.reposRoot ?? this.config.reposRoot;
  }

  view(): SettingsView {
    return {
      authMode: this.current.authMode,
      hasStoredApiKey: this.current.apiKey !== null && this.current.apiKey !== '',
      model: this.current.model,
      permissionMode: this.current.permissionMode,
      effort: this.current.effort,
      dataDir: this.config.dataDir,
      reposRoot: this.reposRoot(),
      platform: process.platform,
      panelWidth: this.panelWidth(),
    };
  }

  update(patch: UpdateSettingsRequest): SettingsView {
    if (patch.authMode !== undefined) this.current.authMode = patch.authMode;
    if (patch.apiKey !== undefined) {
      this.current.apiKey = patch.apiKey.trim() === '' ? null : patch.apiKey.trim();
    }
    if (patch.model !== undefined) this.current.model = patch.model;
    if (patch.permissionMode !== undefined) this.current.permissionMode = patch.permissionMode;
    if (patch.effort !== undefined) this.current.effort = patch.effort;
    if (patch.panelWidth !== undefined) this.current.panelWidth = clampPanel(patch.panelWidth);
    if (patch.reposRoot !== undefined) {
      // Only affects projects created from now on. Moving an existing root
      // would break every worktree: git stores absolute paths in its worktree
      // administration, so a move needs `git worktree repair`, which is a
      // separate job and not one to do silently behind a settings field.
      this.current.reposRoot = patch.reposRoot.trim() === '' ? null : patch.reposRoot.trim();
    }
    this.write();
    return this.view();
  }
}

function clampPanel(width: number): number {
  if (!Number.isFinite(width)) return DEFAULTS.panelWidth;
  return Math.min(PANEL_WIDTH.max, Math.max(PANEL_WIDTH.min, Math.round(width)));
}
