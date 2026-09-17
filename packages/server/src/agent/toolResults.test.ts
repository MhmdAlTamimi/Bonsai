import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_EDIT_LINES, MAX_LINE_CHARS, MAX_OUTPUT_LINES, toolResultFrom } from './toolResults.js';

/**
 * What a tool produced, kept from the harness's structured output.
 *
 * The transcript used to record that `Bash` and `Edit` happened and nothing
 * about what either did, so "what did it run, and what did that change?" was
 * unanswerable from the conversation. These pin the two shapes worth keeping
 * and the trimming that stops a noisy command from carrying a megabyte into
 * the database.
 */
describe('what a tool produced', () => {
  test('a command keeps its output, oldest first, with stderr after stdout', () => {
    const result = toolResultFrom('t1', 'Bash', true, {
      stdout: 'reading 183 documents\nwriting chunks/\n',
      stderr: 'warning: slow bucket\n',
      interrupted: false,
    });
    assert.deepEqual(result, {
      toolUseId: 't1',
      name: 'Bash',
      ok: true,
      output: ['reading 183 documents', 'writing chunks/', 'warning: slow bucket'],
    });
  });

  test('a command that printed a flood keeps a few lines and counts the rest', () => {
    const result = toolResultFrom('t1', 'Bash', true, {
      stdout: Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'),
      stderr: '',
    });
    assert.equal(result?.output?.length, MAX_OUTPUT_LINES);
    assert.equal(result?.dropped, 500 - MAX_OUTPUT_LINES);
    assert.equal(result?.output?.[0], 'line 0');
  });

  test('a very long line is trimmed rather than stored whole', () => {
    const result = toolResultFrom('t1', 'Bash', true, { stdout: 'x'.repeat(5_000), stderr: '' });
    assert.equal(result?.output?.[0]?.length, MAX_LINE_CHARS);
    assert.match(result?.output?.[0] ?? '', /…$/);
  });

  test('a failed command is recorded as failed, with what it said', () => {
    const result = toolResultFrom('t1', 'Bash', false, { stdout: '', stderr: 'command not found' });
    assert.equal(result?.ok, false);
    assert.deepEqual(result?.output, ['command not found']);
  });

  test('an edit keeps its changed lines with the numbers they have in the file', () => {
    const result = toolResultFrom(
      't2',
      'Edit',
      true,
      {
        filePath: '/tmp/node/chunk_writer.py',
        structuredPatch: [
          {
            oldStart: 57,
            oldLines: 4,
            newStart: 57,
            newLines: 5,
            lines: [
              ' def write_chunks(chunks, out):',
              '+    header = sheet_header(rows)',
              '     for i, chunk in enumerate(chunks):',
              '-        body = chunk.text',
              '+        body = header + chunk.text',
            ],
          },
        ],
        gitDiff: { filename: 'chunk_writer.py', additions: 2, deletions: 1 },
      },
      '/tmp/node',
    );
    // Named the way the user names it: inside their experiment's folder.
    assert.equal(result?.edit?.path, 'chunk_writer.py');
    assert.deepEqual([result?.edit?.added, result?.edit?.removed], [2, 1]);
    assert.deepEqual(result?.edit?.lines, [
      { kind: 'context', text: 'def write_chunks(chunks, out):', oldLine: 57, newLine: 57 },
      { kind: 'add', text: '    header = sheet_header(rows)', newLine: 58 },
      { kind: 'context', text: '    for i, chunk in enumerate(chunks):', oldLine: 58, newLine: 59 },
      { kind: 'del', text: '        body = chunk.text', oldLine: 59 },
      { kind: 'add', text: '        body = header + chunk.text', newLine: 60 },
    ]);
  });

  test('without git’s counts, the lines are counted; a huge edit is trimmed and says so', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `+line ${i}`);
    const result = toolResultFrom('t2', 'Write', true, {
      filePath: 'big.py',
      structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 100, lines }],
    });
    assert.equal(result?.edit?.added, 100);
    assert.equal(result?.edit?.removed, 0);
    assert.equal(result?.edit?.lines.length, MAX_EDIT_LINES);
    assert.equal(result?.edit?.truncated, true);
  });

  test('git’s "no newline" note is not a changed line', () => {
    const result = toolResultFrom('t2', 'Edit', true, {
      filePath: 'a.txt',
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ['-a', '\\ No newline at end of file', '+b'],
        },
      ],
    });
    assert.deepEqual(
      result?.edit?.lines.map((l) => l.kind),
      ['del', 'add'],
    );
  });

  test('a tool that answers with neither output nor a patch is not stored', () => {
    // Read, Grep, Glob and the rest: the file they read is not worth doubling
    // the transcript to repeat.
    assert.equal(toolResultFrom('t3', 'Read', true, { file: { content: 'x' } }), null);
    assert.equal(toolResultFrom('t3', 'Grep', true, null), null);
    assert.equal(toolResultFrom('t3', 'Task', true, 'plain text'), null);
  });
});
