/**
 * A stand-in for Anthropic's Messages API, for driving the real Claude Code
 * (the one the Agent SDK bundles) through failures without spending anything.
 *
 * Point the agent at it with ANTHROPIC_BASE_URL and any ANTHROPIC_API_KEY.
 * Requests from the agent's main loop — the ones that offer tools — are
 * answered from a script, one step per request; every other request (titles,
 * checks) gets a short text reply. A step is one of:
 *
 *   'text'          a short reply that ends the turn
 *   'bash:<cmd>'    a Bash tool call running <cmd>
 *   401 | 429 | 500 | 529   that HTTP error, in the API's own error format
 *   'billing'       400, "Your credit balance is too low…"
 *   'hang'          accept the request and never answer
 *
 * Usage figures are fixed per reply, so Claude Code's own cost estimate is
 * the same for every turn and easy to check.
 */
import { createServer } from 'node:http';

const ERRORS = {
  401: ['authentication_error', 'invalid x-api-key'],
  429: ['rate_limit_error', 'This request would exceed your rate limit.'],
  500: ['api_error', 'Internal server error'],
  529: ['overloaded_error', 'Overloaded'],
  billing: [
    'invalid_request_error',
    'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
  ],
};

export const USAGE = { input_tokens: 1000, output_tokens: 100 };

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

function reply(model, blocks, stopReason) {
  const events = [
    {
      type: 'message_start',
      message: {
        id: `msg_${Math.random().toString(36).slice(2)}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          ...USAGE,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
    } else {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: USAGE.output_tokens },
  });
  events.push({ type: 'message_stop' });
  return events;
}

export async function startFakeApi({ captureMessages = false } = {}) {
  const script = [];
  let fallback = 'text';
  const requests = [];
  let tool = 0;
  const hanging = new Set();
  const server = createServer((req, res) => {
    if (req.url === '/__bonsai_audit__') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ server: 'scripts/audit/fake-api.mjs' }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        // Not JSON.
      }
      const mainLoop = Array.isArray(body.tools) && body.tools.length > 0;
      const step = mainLoop ? (script.shift() ?? fallback) : fallback;
      // The result of the tool call this request answers, if any: what the
      // agent's command printed, as Claude Code sends it back.
      const last = Array.isArray(body.messages) ? body.messages.at(-1) : undefined;
      const result = Array.isArray(last?.content)
        ? last.content.find((block) => block.type === 'tool_result')
        : undefined;
      const toolResult =
        result === undefined
          ? undefined
          : typeof result.content === 'string'
            ? result.content
            : (result.content ?? []).map((c) => c.text ?? '').join('');
      requests.push({
        path,
        mainLoop,
        step,
        toolResult,
        at: Date.now(),
        ...(captureMessages ? { messages: body.messages } : {}),
      });
      if (path !== '/v1/messages') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'not_found_error', message: 'Not found' },
          }),
        );
        return;
      }
      if (step === 'hang') {
        hanging.add(res);
        return;
      }
      const error = ERRORS[step];
      if (error !== undefined) {
        const status = step === 'billing' ? 400 : Number(step);
        res.writeHead(status, {
          'content-type': 'application/json',
          // A short retry-after on every retryable error keeps the cases quick.
          ...([429, 500, 529].includes(status) ? { 'retry-after': '1' } : {}),
        });
        res.end(JSON.stringify({ type: 'error', error: { type: error[0], message: error[1] } }));
        return;
      }
      const model = body.model ?? 'claude-sonnet-4-5';
      const blocks =
        typeof step === 'string' && step.startsWith('bash:')
          ? [
              {
                type: 'tool_use',
                id: `toolu_${++tool}`,
                name: 'Bash',
                input: { command: step.slice(5), description: 'step' },
              },
            ]
          : [{ type: 'text', text: 'Done.' }];
      const stop = blocks[0].type === 'tool_use' ? 'tool_use' : 'end_turn';
      if (body.stream === true) {
        sse(res, reply(model, blocks, stop));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_plain',
            type: 'message',
            role: 'assistant',
            model,
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: USAGE,
          }),
        );
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    /** Replaces what the next main-loop requests get. */
    script: (...steps) => {
      script.length = 0;
      script.push(...steps);
    },
    /** What every request not covered by the script gets, main loop or not. */
    otherwise: (step) => {
      fallback = step;
    },
    requests,
    stop: async () => {
      for (const res of hanging) res.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
