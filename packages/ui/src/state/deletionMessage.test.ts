import { test } from 'node:test';
import assert from 'node:assert/strict';

import { experimentDeletionMessage } from './deletionMessage.ts';

const impact = {
  nodes: 1,
  names: ['try-redis'],
  costUsd: 0,
  commits: 1,
  comparisons: [] as Array<{ id: string; title: string }>,
};

test('deleting an experiment names the comparisons that include it', () => {
  assert.ok(!experimentDeletionMessage(impact).some((p) => p.includes('comparison')));

  const one = experimentDeletionMessage({
    ...impact,
    comparisons: [{ id: 'c1', title: 'try-redis vs try-lru' }],
  }).join('\n');
  assert.match(one, /Included in the comparison “try-redis vs try-lru”\./);
  assert.match(one, /will show it as deleted/);

  const many = experimentDeletionMessage({
    ...impact,
    nodes: 2,
    names: ['try-redis', 'child'],
    comparisons: [
      { id: 'c1', title: 'A vs B' },
      { id: 'c2', title: 'A vs C' },
    ],
  }).join('\n');
  assert.match(many, /Included in 2 comparisons: “A vs B”, “A vs C”\./);
  assert.match(many, /will show them as deleted/);
  assert.match(many, /Affected experiments: try-redis, child/);
});
