import type { NextRunSettings, PermissionMode } from '@bonsai/shared';

/** One resolution rule for previews and the actual invocation. */
export function resolveRunSettings(
  node: { model: string | null; permission_mode: PermissionMode | null },
  project: {
    default_model: string | null;
    default_effort: string | null;
    default_permission_mode: PermissionMode;
  },
  app?: { model(): string | null; effort(): string | null },
): NextRunSettings {
  return {
    model: node.model ?? project.default_model ?? app?.model() ?? null,
    effort: project.default_effort ?? app?.effort() ?? null,
    permissionMode: node.permission_mode ?? project.default_permission_mode ?? 'acceptEdits',
    modelSource:
      node.model !== null ? 'experiment' : project.default_model !== null ? 'project' : 'app',
    effortSource: project.default_effort !== null ? 'project' : 'app',
    permissionSource: node.permission_mode !== null ? 'experiment' : 'project',
  };
}
