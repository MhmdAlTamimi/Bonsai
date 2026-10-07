import { createProject, adoptProject } from '../projects.js';

/** Existing worktree regression fixtures represent pre-conversion projects. */
export function createLegacyProject(
  store: Parameters<typeof createProject>[0],
  input: Parameters<typeof createProject>[1],
) {
  return createProject(store, { ...input, workspaceMode: 'legacy' });
}

export function adoptLegacyProject(
  store: Parameters<typeof adoptProject>[0],
  input: Parameters<typeof adoptProject>[1],
) {
  return adoptProject(store, { ...input, workspaceMode: 'legacy' });
}
