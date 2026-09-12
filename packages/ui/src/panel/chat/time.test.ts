import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exactTime, relativeTime } from './time.ts';

const NOW = Date.parse('2026-09-12T12:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

test('anything under a minute reads as just now', () => {
  assert.equal(relativeTime(ago(0), NOW), 'just now');
  assert.equal(relativeTime(ago(30_000), NOW), 'just now');
});

test('a clock skewed into the future does not read as negative', () => {
  assert.equal(relativeTime(new Date(NOW + 5_000).toISOString(), NOW), 'just now');
});

test('minutes, hours and days each get their own unit', () => {
  assert.equal(relativeTime(ago(5 * 60_000), NOW), '5m ago');
  assert.equal(relativeTime(ago(3 * 3_600_000), NOW), '3h ago');
  assert.equal(relativeTime(ago(3 * 86_400_000), NOW), '3d ago');
});

test('one day is yesterday', () => {
  assert.equal(relativeTime(ago(86_400_000), NOW), 'yesterday');
});

test('an unparseable timestamp is empty rather than "Invalid Date"', () => {
  assert.equal(relativeTime('not a date', NOW), '');
  assert.equal(exactTime('not a date'), 'not a date');
});
