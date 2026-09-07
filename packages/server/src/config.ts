import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * D14c: state lives in SQLite in an app data directory, never browser storage.
 * D14e: the repo path is config and is never hardcoded.
 */
export interface Config {
  port: number;
  /** Where bonsai.db lives. */
  dataDir: string;
  /** Where per-project bare repos and worktrees live. */
  reposRoot: string;
  defaultModel: string | null;
  /** Non-interactive until the ask-user mechanism lands. */
  defaultPermissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
}

function appDataDir(): string {
  const override = process.env['BONSAI_DATA_DIR'];
  if (override) return override;
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Bonsai');
  }
  if (process.platform === 'win32') {
    // LOCALAPPDATA, not APPDATA. APPDATA roams: in an AD environment it is
    // synced to the domain controller at every logon, and Bonsai's data
    // directory holds a git repo and a worktree per node. Roaming that is
    // gigabytes over the network for data that is inherently machine-local.
    return join(process.env['LOCALAPPDATA'] ?? process.env['APPDATA'] ?? homedir(), 'Bonsai');
  }
  return join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'bonsai');
}

export function loadConfig(): Config {
  const dataDir = appDataDir();
  return {
    port: Number(process.env['BONSAI_PORT'] ?? 8787),
    dataDir,
    reposRoot: process.env['BONSAI_REPOS_ROOT'] ?? join(dataDir, 'repos'),
    defaultModel: process.env['BONSAI_MODEL'] ?? null,
    defaultPermissionMode: 'acceptEdits',
  };
}
