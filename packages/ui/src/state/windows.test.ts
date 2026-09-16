import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_WINDOWS,
  NO_WINDOWS,
  closeWindow,
  cycleWindows,
  fitAll,
  frontWindow,
  moveWindow,
  openWindow,
  resizeWindow,
  showFile,
  stackWindows,
  tileWindows,
  toggleMaximized,
  toggleMinimized,
  windowId,
  type Windows,
} from './windows.ts';

const AREA = { width: 1000, height: 700 };
const ALL = { kind: 'all' } as const;
const open = (state: Windows, path: string, scope: Parameters<typeof windowId>[0] = ALL): Windows =>
  openWindow(state, { path, scope, scopeLabel: 'All changes' }, AREA);

const inside = (state: Windows, area = AREA): void => {
  for (const w of state.list) {
    assert.ok(w.x >= 0 && w.y >= 0, `${w.path} starts on the map`);
    assert.ok(
      w.x + w.width <= area.width && w.y + w.height <= area.height,
      `${w.path} ends on the map`,
    );
  }
};

describe('floating diff windows', () => {
  test('new windows cascade, and the newest is in front', () => {
    const state = open(open(NO_WINDOWS, 'a.py'), 'b.py');
    const [a, b] = state.list;
    assert.ok(b!.x > a!.x && b!.y > a!.y, 'each steps down and right');
    assert.equal(frontWindow(state)?.path, 'b.py');
    inside(state);
  });

  test('opening a file that is open brings its window forward instead of a copy', () => {
    let state = open(open(NO_WINDOWS, 'a.py'), 'b.py');
    state = toggleMinimized(state, windowId(ALL, 'a.py'));
    state = open(state, 'a.py');
    assert.equal(state.list.length, 2);
    assert.equal(frontWindow(state)?.path, 'a.py');
    assert.equal(state.list.find((w) => w.path === 'a.py')?.minimized, false, 'and restored');
  });

  test('the same file from a different scope is a different window', () => {
    const state = open(open(NO_WINDOWS, 'a.py'), 'a.py', { kind: 'run', runId: 'r1' });
    assert.equal(state.list.length, 2);
  });

  test('never more than four: a fifth replaces the one opened longest ago', () => {
    let state = NO_WINDOWS;
    for (const path of ['1', '2', '3', '4']) state = open(state, path);
    // Bringing the oldest forward does not make it newer.
    state = open(state, '1');
    state = open(state, '5');
    assert.equal(state.list.length, MAX_WINDOWS);
    assert.deepEqual(state.list.map((w) => w.path).sort(), ['2', '3', '4', '5']);
  });

  test('moving and resizing never leave the map, or go below a readable size', () => {
    let state = open(NO_WINDOWS, 'a.py');
    const id = windowId(ALL, 'a.py');
    state = moveWindow(state, id, 5000, -300, AREA);
    inside(state);
    state = resizeWindow(state, id, { x: -50, y: 10, width: 40, height: 5000 }, AREA);
    const w = state.list[0]!;
    assert.equal(w.width, 320);
    assert.equal(w.height, AREA.height);
    inside(state);
  });

  test('tile puts them side by side with equal shares; stack cascades them again', () => {
    let state = NO_WINDOWS;
    for (const path of ['a', 'b', 'c']) state = open(state, path);
    state = toggleMinimized(state, windowId(ALL, 'b'));
    state = toggleMaximized(state, windowId(ALL, 'c'));

    const tiled = tileWindows(state, AREA);
    const byPath = new Map(tiled.list.map((w) => [w.path, w]));
    assert.ok(byPath.get('a')!.x < byPath.get('b')!.x && byPath.get('b')!.x < byPath.get('c')!.x);
    assert.equal(new Set(tiled.list.map((w) => w.y)).size, 1, 'one row');
    assert.equal(new Set(tiled.list.map((w) => w.width)).size, 1, 'equal widths');
    assert.ok(
      tiled.list.every((w) => !w.minimized && !w.maximized),
      'all shown',
    );
    inside(tiled);

    let four = tiled;
    four = open(four, 'd');
    const grid = tileWindows(four, AREA);
    assert.equal(new Set(grid.list.map((w) => w.y)).size, 2, 'four is two rows of two');
    inside(grid);

    const stacked = stackWindows(grid, AREA);
    const order = [...stacked.list].sort((x, y) => x.opened - y.opened);
    assert.ok(order[1]!.x > order[0]!.x);
    assert.equal(frontWindow(stacked)?.path, 'd', 'newest in front');
    inside(stacked);
  });

  test('a smaller map pulls every window back onto it', () => {
    let state = open(NO_WINDOWS, 'a.py');
    state = moveWindow(state, windowId(ALL, 'a.py'), 400, 300, AREA);
    const small = { width: 500, height: 400 };
    const fitted = fitAll(state, small);
    inside(fitted, small);
    assert.equal(fitAll(fitted, small), fitted, 'unchanged when nothing needs to move');
  });

  test('previous and next reuse the window, unless that file is open already', () => {
    let state = open(open(NO_WINDOWS, 'a.py'), 'b.py');
    const a = windowId(ALL, 'a.py');
    state = showFile(state, a, 'c.py');
    assert.deepEqual(state.list.map((w) => w.path).sort(), ['b.py', 'c.py']);
    state = showFile(state, windowId(ALL, 'c.py'), 'b.py');
    assert.deepEqual(
      state.list.map((w) => w.path),
      ['b.py'],
      'the other window comes forward and this one closes',
    );
  });

  test('the keyboard cycles through windows that are showing', () => {
    let state = NO_WINDOWS;
    for (const path of ['a', 'b', 'c']) state = open(state, path);
    // c is in front; forward wraps round to a, and keeps going.
    assert.equal(frontWindow(cycleWindows(state, 1))?.path, 'a');
    assert.equal(frontWindow(cycleWindows(cycleWindows(state, 1), 1))?.path, 'b');
    assert.equal(frontWindow(cycleWindows(cycleWindows(cycleWindows(state, 1), 1), 1))?.path, 'c');
    assert.equal(frontWindow(cycleWindows(state, -1))?.path, 'b');
    assert.equal(
      cycleWindows(closeWindow(closeWindow(state, windowId(ALL, 'a')), windowId(ALL, 'b')), 1).list
        .length,
      1,
    );
  });
});
