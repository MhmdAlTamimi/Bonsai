import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  draftKey,
  writeDraft,
  readDraft,
  clearSubmittedDraft,
  readAttachments,
  writeAttachments,
} from './drafts.ts';

test('acknowledgments clear only the submitted owner and preserve later edits', () => {
  const a = draftKey('project', 'a', 'reply');
  const b = draftKey('project', 'b', 'reply');
  writeDraft(a, 'first');
  writeDraft(b, 'other');
  writeDraft(a, 'later');
  clearSubmittedDraft(a, 'first');
  assert.equal(readDraft(a), 'later');
  assert.equal(readDraft(b), 'other');
  clearSubmittedDraft(a, 'later');
  assert.equal(readDraft(a), '');
  assert.equal(readDraft(b), 'other');
  assert.equal(readDraft(draftKey('another-project', 'b', 'reply')), '');
});

test('attached references belong to one draft and keep the same list until changed', () => {
  const a = draftKey('project', 'a', 'reply');
  const b = draftKey('project', 'b', 'reply');
  // Stable while nothing changes, so a React store snapshot does not loop.
  assert.equal(readAttachments(a), readAttachments(a));
  writeAttachments(a, ['smoke-test']);
  assert.deepEqual(readAttachments(a), ['smoke-test']);
  assert.deepEqual(readAttachments(b), []);
  writeAttachments(a, []);
  assert.deepEqual(readAttachments(a), []);
});
