import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  fileName,
  isFailureLine,
  runningLabel,
  segments,
  summarise,
  toStep,
  type StepInput,
} from './activity-summary.ts';

const step = (input: Partial<StepInput> & Pick<StepInput, 'name' | 'detail'>) =>
  toStep({ result: undefined, live: false, ...input });
const edit = (path: string, added: number, removed: number) => ({
  toolUseId: 't',
  name: 'Edit',
  ok: true,
  edit: { path, added, removed, lines: [] },
});

describe('what the agent did, in words', () => {
  test('each step is named for what it did to which file', () => {
    assert.equal(
      step({ name: 'Read', detail: '/w/chunking/chunk_writer.py' }).label,
      'Read **chunk_writer.py**',
    );
    assert.equal(
      step({
        name: 'Write',
        detail: 'tests/t.py',
        result: { ...edit('tests/t.py', 24, 0), name: 'Write' },
      }).label,
      'Created **t.py**',
    );
    const edited = step({ name: 'Edit', detail: 'a/b.py', result: edit('a/b.py', 1, 3) });
    assert.equal(edited.label, 'Edited **b.py**');
    assert.deepEqual([edited.added, edited.removed], [1, 3]);
  });

  test('a command is described by its purpose when the agent gave one', () => {
    assert.equal(
      step({ name: 'Bash', detail: 'pytest -q', description: 'Run the full suite' }).label,
      'Run the full suite',
    );
    assert.equal(step({ name: 'Bash', detail: 'pytest -q' }).label, 'Ran **pytest -q**');
    const failed = step({
      name: 'Bash',
      detail: 'pytest',
      result: { toolUseId: 't', name: 'Bash', ok: false, output: ['1 failed'] },
    });
    assert.equal(failed.failed, true);
  });

  test('a stretch reads as one sentence: files by name, then counts', () => {
    assert.equal(
      summarise([
        step({ name: 'Read', detail: 'chunk_writer.py' }),
        step({ name: 'Bash', detail: 'grep -n x' }),
      ]),
      'Read **chunk_writer.py**, ran a command',
    );
    assert.equal(
      summarise([
        step({ name: 'Edit', detail: 'a.py', result: edit('a.py', 1, 3) }),
        step({ name: 'Bash', detail: 'pytest t' }),
        step({ name: 'Bash', detail: 'pytest' }),
      ]),
      'Edited **a.py**, ran 2 commands',
    );
    assert.equal(summarise([step({ name: 'Bash', detail: 'x' })]), 'Ran a command');
    assert.equal(
      summarise([
        step({ name: 'Read', detail: 'a.py' }),
        step({ name: 'Read', detail: 'b.py' }),
        step({ name: 'Read', detail: 'a.py' }),
        step({ name: 'Grep', detail: 'x' }),
      ]),
      'Read 2 files, searched the code',
    );
  });

  test('a running step is said in the present tense', () => {
    assert.equal(
      runningLabel(step({ name: 'Bash', detail: 'pytest -q', live: true })),
      'Running **pytest -q**',
    );
    assert.equal(
      runningLabel(step({ name: 'Read', detail: 'x/y.md', live: true })),
      'Reading **y.md**',
    );
  });

  test('a reference read keeps its own name', () => {
    assert.equal(
      step({
        name: 'Read',
        detail: '/s/run-context/r/references/smoke-test.md',
        subject: '@smoke-test',
      }).label,
      'Read **@smoke-test**',
    );
  });

  test('markup, file names and failure lines', () => {
    assert.deepEqual(segments('Read **a.py**, ran a command'), [
      { text: 'Read ', lifted: false },
      { text: 'a.py', lifted: true },
      { text: ', ran a command', lifted: false },
    ]);
    assert.equal(fileName('C:\\w\\src\\a.ts'), 'a.ts');
    assert.equal(isFailureLine('E       AssertionError: chunk_001.md'), true);
    assert.equal(isFailureLine('1 failed, 1 passed in 0.21s'), true);
    assert.equal(isFailureLine('2 passed in 0.19s'), false);
  });
});
