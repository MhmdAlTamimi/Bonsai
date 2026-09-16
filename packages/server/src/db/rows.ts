import { join, resolve, sep } from 'node:path';
import type { NodeStatus, PermissionMode, RunEndReason } from '@bonsai/shared';

import type { LineageNode } from '../domain/lineage.js';

/**
 * The row shapes, and the handful of pure functions that read them.
 *
 * Every concern-specific store below this file needs the row types, and several
 * need the same three or four parsers. Keeping them here is what lets the
 * stores stay independent of each other: `nodeStore` does not import
 * `projectStore` to learn what a `ProjectRow` is.
 *
 * Nothing here touches the database. If a function needs a query it belongs in
 * one of the stores, not here.
 */

/** The full node row. Only the server ever sees this shape. */
export interface NodeRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  display_name: string;
  description: string;
  session_id: string | null;
  forked_from_message_seq: number | null;
  branch_name: string | null;
  base_commit: string | null;
  head_commit: string | null;
  worktree_path: string;
  status: NodeStatus;
  model: string | null;
  permission_mode: PermissionMode | null;
  success_criteria: string | null;
  verification_hint: string | null;
  setup_ran_at: string | null;
  position_x: number | null;
  position_y: number | null;
  created_at: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  repo_path: string;
  scratch_path: string | null;
  /**
   * D37: the agent's working directory, relative to the repository root, with
   * '/' separators and '' meaning the root itself.
   *
   * The repository is the project's identity -- its branches, its history, its
   * commits, whole. This is only where the agent stands inside it. Null for a
   * row written before the column existed, which means the root.
   */
  work_dir: string | null;
  default_model: string | null;
  default_permission_mode: PermissionMode;
  default_effort: string | null;
  source_kind: 'created' | 'adopted';
  source_path: string | null;
  protected_branch: string | null;
  copy_files: string | null;
  setup_command: string | null;
  created_at: string;
}

/** What a finished run reports. Cost is an estimate at list price, not a bill. */
/** How a run ended: its status, and why (D45). */
export interface RunEnd {
  status: 'done' | 'cancelled' | 'failed';
  reason: RunEndReason;
  /** A failure's message. Null for everything else. */
  error: string | null;
}

export interface RunTotals {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  model?: string | null;
  /** 'none' means a subscription login: no per-token charge. */
  apiKeySource?: string | null;
  /** The commit this run produced, if it produced one. */
  commitSha?: string | null;
  /** The node's cumulative change against its base, as of this run. */
  stat?: { files: number; insertions: number; deletions: number } | null;
  /** This run's own change: its commit against the one before. */
  change?: { files: number; insertions: number; deletions: number } | null;
  /** Jobs and processes still running that had to be stopped when it ended. */
  stoppedBackground?: number;
  /** The tool names the agent was offered. See the schema for why it is kept. */
  toolsOffered?: readonly string[] | null;
  toolCalls?: number;
  durationMs?: number | null;
}

export const now = (): string => new Date().toISOString();

/** True for the one node whose worktree the user owns: an adopted master. */
export function isUsersOwnCheckout(project: ProjectRow | undefined, row: NodeRow): boolean {
  return project?.source_kind === 'adopted' && row.parent_id === null;
}

export function toLineage(row: NodeRow): LineageNode {
  return {
    id: row.id,
    parentId: row.parent_id,
    baseCommit: row.base_commit,
    headCommit: row.head_commit,
  };
}

/** An untouched optional field and an empty one mean the same thing: absent. */
export function blankToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Shared by the tool list and the copy-files list; both are JSON arrays.
 *
 * Tolerant on purpose: a malformed row should not break the whole panel.
 */
export function parseStringArray(value: unknown): string[] | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : null;
  } catch {
    return null;
  }
}

/**
 * The folder the agent actually works in: a node's worktree plus the project's
 * working subdirectory. The worktree root when there is no subdirectory.
 */
export function workDirIn(worktreePath: string, workDir: string | null): string {
  const relative = (workDir ?? '').replace(/^[/\\]+|[/\\]+$/g, '');
  return relative === '' ? worktreePath : join(worktreePath, ...relative.split('/'));
}

export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  return child === p || child.startsWith(p + sep);
}
