/** Verify the real bundled SDK's connection classifications only against the fake API. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeApi } from './fake-api.mjs';
import { startBonsai } from './lib.mjs';

const root = await mkdtemp(join(tmpdir(), 'bonsai-connection-errors-'));
const fake = await startFakeApi();
const home = join(root, 'home');
await mkdir(home);
const bonsai = await startBonsai(
  join(root, 'data'),
  { HOME: home, ANTHROPIC_BASE_URL: fake.url },
  { realAgent: true },
);
try {
  await bonsai.api('PATCH', '/api/settings', {
    authMode: 'api_key',
    apiKey: 'sk-ant-api03-audit-fake',
  });
  for (const [failure, expected] of [
    [401, 'no_credential'],
    ['billing', 'error'],
    [429, 'rate_limited'],
  ]) {
    fake.otherwise(failure);
    const before = fake.requests.length;
    const started = Date.now();
    const response = await bonsai.api('POST', '/api/connection/check');
    const elapsedMs = Date.now() - started;
    console.log(
      JSON.stringify({
        failure,
        state: response.body.state,
        elapsedMs,
        requests: fake.requests.length - before,
      }),
    );
    assert.equal(response.body.state, expected);
    assert.doesNotMatch(response.body.message ?? '', /timed out|offline/);
    assert.ok(
      elapsedMs < 20000,
      'terminal failure must finish before the old 45 second probe timeout',
    );
  }
} finally {
  await bonsai.stop();
  await fake.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
