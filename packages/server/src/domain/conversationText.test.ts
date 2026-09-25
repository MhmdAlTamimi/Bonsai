import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageView } from '@bonsai/shared';

import { conversationText } from './conversationText.js';

let seq = 0;
const message = (
  role: MessageView['role'],
  kind: MessageView['kind'],
  content: unknown,
): MessageView => ({
  id: `m${++seq}`,
  nodeId: 'n',
  runId: 'r',
  seq,
  role,
  kind,
  content,
  createdAt: '',
});
const user = (text: string) => message('user', 'text', text);
const agent = (text: string) => message('assistant', 'text', text);
const ran = (command: string) =>
  message('assistant', 'tool_use', { name: 'Bash', detail: command });
const output = (lines: string[]) =>
  message('assistant', 'tool_result', { toolUseId: 't', name: 'Bash', ok: true, output: lines });

describe('an experiment conversation as draft input', () => {
  test('everything goes in when it fits, notes first', () => {
    const { text, basis } = conversationText(
      [user('try redis'), ran('npm test'), output(['12 passed']), agent('p95 is 40ms')],
      '## Testing\n\nRan npm test: 12 passed',
    );
    assert.match(text, /^## Experiment notes \(CONTEXT\.md\)\n\n## Testing/);
    assert.match(
      text,
      /User: try redis\n\[Bash: npm test\]\n\(output\)\n12 passed\nAgent: p95 is 40ms$/,
    );
    assert.deepEqual(basis, { messages: 4, included: 4, toolOutputOmitted: false, notes: true });
  });

  test('tool output goes first, keeping which tool ran', () => {
    const big = Array.from({ length: 200 }, (_, i) => `log line ${i}`);
    const { text, basis } = conversationText(
      [user('try redis'), ran('npm test'), output(big), agent('p95 is 40ms')],
      null,
      300,
    );
    assert.doesNotMatch(text, /log line/);
    assert.match(text, /\[Bash: npm test\]/);
    assert.equal(basis.toolOutputOmitted, true);
    assert.equal(basis.included, 4);
  });

  test('then the middle goes, keeping the first request and the latest turns', () => {
    const middle = Array.from({ length: 50 }, (_, i) => agent(`thinking step ${i} `.repeat(4)));
    const { text, basis } = conversationText(
      [user('the original ask'), ...middle, agent('the final answer')],
      null,
      700,
    );
    assert.match(
      text,
      /^## Conversation\n\nUser: the original ask\n\[\d+ earlier messages left out to fit\]/,
    );
    assert.match(text, /Agent: the final answer$/);
    assert.ok(basis.included < basis.messages);
    assert.equal(basis.messages, 52);
  });

  test('a compaction and other notes read as notes', () => {
    const { text } = conversationText(
      [
        message('system', 'text', {
          compaction: { trigger: 'auto', tokensBefore: 1, tokensAfter: 1 },
        }),
        message('system', 'text', 'Setup finished'),
      ],
      null,
    );
    assert.match(text, /Note: the conversation was compacted here\.\nNote: Setup finished/);
  });
});
