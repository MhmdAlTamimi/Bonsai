import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ApiCallError } from './ApiCallError.ts';
import { describeError } from './describeError.ts';

/**
 * Turning a failure into a sentence.
 *
 * Two properties are worth protecting, and they pull against each other. The
 * user must never see raw exception text -- `TypeError: Failed to fetch` in a
 * banner tells them nothing except that they are on their own. But a message
 * the SERVER wrote must survive: those are written for this user about this
 * situation, and replacing "This folder is the node try Redis in your project
 * API rewrite" with something generic would be strictly worse.
 *
 * So the rule under test is: pass the server's words through, and add the way
 * out.
 */
describe('describeError', () => {
  test('never leaks the shape of a JavaScript error', () => {
    for (const thrown of [
      new TypeError('Failed to fetch'),
      new Error('Cannot read properties of undefined (reading "id")'),
      'a bare string',
      { unexpected: true },
    ]) {
      const message = describeError(thrown);
      assert.ok(!message.includes('TypeError'), message);
      assert.ok(!message.startsWith('Error:'), message);
      assert.ok(!message.includes('[object Object]') || typeof thrown !== 'object', message);
    }
  });

  test('a dead server says so, and says where to look', () => {
    // What the browser actually throws when nothing is listening. "Failed to
    // fetch" is true and useless; on a local app the cause is almost always
    // that the server stopped.
    const message = describeError(new TypeError('Failed to fetch'));
    assert.match(message, /Bonsai server/);
    assert.match(message, /terminal|reload/);
  });

  test("keeps the server's own words, which are the specific ones", () => {
    const specific = 'This folder is the node try Redis in your project API rewrite.';
    assert.ok(describeError(new ApiCallError(specific, 400)).includes(specific));

    const refusal = 'node_modules: dependencies are far too large to copy per node';
    assert.ok(describeError(new ApiCallError(refusal, 400)).includes(refusal));
  });

  test('adds a way out to the statuses that have one', () => {
    // Not connected: the server names the cause, this names the fix.
    const gate = describeError(new ApiCallError('Bonsai is not connected to Claude.', 428));
    assert.match(gate, /Settings/);

    // Already running: "wait or stop" is the whole content of the situation.
    const busy = describeError(new ApiCallError('this node is already running', 409));
    assert.match(busy, /already running/);
    assert.match(busy, /Stop/);

    // Gone: a reload is what makes the screen agree with reality again.
    const gone = describeError(new ApiCallError('no such node', 404));
    assert.match(gone, /reload/i);

    // A server fault the user cannot diagnose: point at the button that
    // collects everything needed to diagnose it.
    const broken = describeError(new ApiCallError('something went wrong', 500));
    assert.match(broken, /diagnostics/i);
  });

  test('an unbuilt route says so rather than looking like a bug', () => {
    const named = describeError(new ApiCallError('answering a question lands later', 501, 'later'));
    assert.match(named, /not built yet/);

    const unnamed = describeError(new ApiCallError('that route is a stub', 501));
    assert.match(unnamed, /not built yet/);
  });
});
