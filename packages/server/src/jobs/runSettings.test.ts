import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunSettings } from './runSettings.js';

test('next-run preview resolves app fallback, project defaults and legacy experiment overrides', () => {
  const node = { model: null, permission_mode: null };
  const project = {
    default_model: null,
    default_effort: null,
    default_permission_mode: 'default' as const,
  };
  const app = { model: () => 'app-model', effort: () => 'high' };
  assert.deepEqual(resolveRunSettings(node, project, app), {
    model: 'app-model',
    effort: 'high',
    permissionMode: 'default',
    modelSource: 'app',
    effortSource: 'app',
    permissionSource: 'project',
  });
  assert.deepEqual(
    resolveRunSettings(
      { model: 'legacy-model', permission_mode: 'plan' },
      { ...project, default_model: 'project-model', default_effort: 'low' },
      app,
    ),
    {
      model: 'legacy-model',
      effort: 'low',
      permissionMode: 'plan',
      modelSource: 'experiment',
      effortSource: 'project',
      permissionSource: 'experiment',
    },
  );
});
