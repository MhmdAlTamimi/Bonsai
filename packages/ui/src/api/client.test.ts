import { test } from 'node:test';
import assert from 'node:assert/strict';

// Vite supplies this compile-time constant in the app. Tests use no browser or server.
Object.defineProperty(globalThis, '__BONSAI_BUILD_ID__', { value: 'test' });
const { api, ApiCallError } = await import('./client.ts');

test('a cancelled response body cannot become successful comparison data', async (t) => {
  const cancelled = new DOMException('Response cancelled', 'AbortError');
  t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(
      new Response(new ReadableStream({ start: (controller) => controller.error(cancelled) })),
    ),
  );
  await assert.rejects(api.comparison('fixture'), (error: unknown) => error === cancelled);
});

test('invalid successful JSON rejects, while a non-JSON server error keeps its HTTP status', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(new Response('invalid JSON')),
  );
  await assert.rejects(api.comparison('fixture'), SyntaxError);
  fetch.mock.mockImplementation(() =>
    Promise.resolve(
      new Response('Service unavailable', { status: 503, statusText: 'Service Unavailable' }),
    ),
  );
  await assert.rejects(
    api.comparison('fixture'),
    (error: unknown) => error instanceof ApiCallError && error.status === 503,
  );
});
