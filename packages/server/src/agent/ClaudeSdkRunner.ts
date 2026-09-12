import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  EffortLevel,
  ModelUsage,
  Options,
  PermissionMode,
} from '@anthropic-ai/claude-agent-sdk';

import type { AgentRunner, RunEvent, RunSpec } from './AgentRunner.js';
import { READ_ONLY_TOOLS, gitGuardHook } from './guards.js';

/**
 * D15: the Claude Agent SDK, not the raw API -- the same harness as Claude Code,
 * so file editing, search and bash are already reliable.
 *
 * Everything milestone-specific lives above this class. The run pipeline already
 * decides when to commit, when to freeze and what a node's git base is; this
 * only turns a RunSpec into a query() and its messages into RunEvents.
 */
export class ClaudeSdkRunner implements AgentRunner {
  async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    spec.signal.addEventListener('abort', abort, { once: true });

    const options: Options = {
      // D17: the worktree is the isolation boundary. Every node has one,
      // including the conversation-only ones.
      cwd: spec.cwd,
      abortController: controller,

      /**
       * Two different jobs, so two different mechanisms.
       *
       * READ-ONLY runs get an allow-list, because restriction is the whole
       * point: a tool that is not named cannot be called, which is what makes
       * a frozen node genuinely read-only rather than politely asked (D18).
       *
       * WRITABLE runs get an approval callback instead. An allow-list here was
       * a latent bug: it doubles as the pre-approval list, so every tool the
       * agent might reach for has to be named exactly, and any tool this
       * harness offers under a name Bonsai does not know is silently
       * unavailable. The failure mode is the worst kind -- the agent cannot
       * edit, says so in prose, the run completes "successfully" and commits
       * nothing. canUseTool approves whatever the harness offers, so Bonsai
       * never has to keep a list of tool names in sync with the SDK.
       *
       * Nothing is loosened by this: the git hook below still blocks mutating
       * git, and read-only nodes are still restricted by name.
       *
       * That callback is also where a run stops to ask (D34). See `gate`.
       */
      ...(spec.readOnly ? { allowedTools: [...READ_ONLY_TOOLS] } : { canUseTool: gate(spec) }),

      // D19/D30: the app owns git. Read-only git stays available for recovery.
      ...(spec.readOnly ? {} : { hooks: { PreToolUse: [gitGuardHook()] } }),

      permissionMode: spec.permissionMode as PermissionMode,
      // A key stored in Settings reaches the subprocess here rather than being
      // written into this process's environment.
      ...(spec.agentEnv === null ? {} : { env: { ...process.env, ...spec.agentEnv } }),
      ...(spec.model === null ? {} : { model: spec.model }),

      // Bonsai's own instructions only. Without this the SDK would also load
      // the user's ~/.claude and the checked-out repo's settings, which would
      // let a project Bonsai generated change how Bonsai runs its own agents.
      settingSources: [],

      /**
       * excludeDynamicSections matters more here than in most SDK uses, and it
       * is free.
       *
       * The preset normally embeds per-session detail -- working directory,
       * git status, memory paths -- directly in the system prompt, which makes
       * that prompt different for every node and therefore uncacheable. Bonsai
       * runs a SEPARATE SESSION PER NODE against the same instructions, so that
       * is the worst possible shape: every run pays full price for a system
       * prompt it shares with every other run. Excluding those sections leaves
       * a static, cross-session-cacheable prefix; the stripped context is
       * re-injected as the first user message, so the agent still has it.
       */
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: SYSTEM_APPEND,
        excludeDynamicSections: true,
      },

      // D32: reasoning effort as a setting. Lower effort means fewer thinking
      // tokens and fewer, more consolidated tool calls -- the main lever on
      // cost after the model itself.
      ...(spec.effort === null ? {} : { effort: spec.effort as EffortLevel }),
    };

    /**
     * D16: memory across nodes is session forking.
     *
     *   forking  -- a child's first run resumes its PARENT's session with
     *               forkSession, so it inherits the whole ancestor conversation
     *               while leaving the parent untouched and siblings invisible.
     *   resuming -- a node's later runs continue its OWN session, so chatting
     *               with a leaf three times is one conversation (§6.3).
     *
     * The distinction is decided by the pipeline, not here: `resumeSessionId`
     * is already the right session and `forkSession` already says which of the
     * two this is.
     */
    if (spec.resumeSessionId !== null) {
      options.resume = spec.resumeSessionId;
      options.forkSession = spec.forkSession;
    }

    let sessionAnnounced = false;

    try {
      for await (const message of query({ prompt: promptWithCriteria(spec), options })) {
        // session_id rides every message. A forked run gets a NEW one, which is
        // the id this node must store -- storing the parent's would make later
        // chats on this node write into the parent's conversation.
        if (!sessionAnnounced && 'session_id' in message && message.session_id) {
          sessionAnnounced = true;
          yield { type: 'session', sessionId: message.session_id };
        }

        if (message.type === 'system' && message.subtype === 'init') {
          // Bonsai sets no model unless a project or node overrides one (D32),
          // so this is the SDK's default and the only place it is observable.
          //
          // apiKeySource says which credential is paying. 'none' is a claude.ai
          // subscription login, where nothing is charged per token -- so the
          // cost figure below is an API-equivalent estimate, not money spent,
          // and the UI has to say which.
          yield {
            type: 'model',
            model: message.model,
            apiKeySource: message.apiKeySource,
            // Recorded so a run that edited nothing can be diagnosed: either
            // the agent chose not to, or the tool it needed was not offered.
            tools: message.tools,
          };
        } else if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text.trim() !== '') {
              yield { type: 'text', text: block.text };
            } else if (block.type === 'tool_use') {
              yield { type: 'tool', name: block.name, detail: describeToolInput(block.input) };
            }
          }
        } else if (message.type === 'result') {
          if (message.subtype !== 'success') {
            // An error result still carries cost, so report it before failing.
            yield usageEvent(message);
            yield {
              type: 'error',
              error: message.errors?.join('; ') || `the run ended: ${message.subtype}`,
            };
            return;
          }
          // D20: cost and tokens captured per run from day one.
          yield usageEvent(message);
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return; // cancellation is not a failure
      throw err;
    } finally {
      spec.signal.removeEventListener('abort', abort);
    }
  }
}

/**
 * The approval callback: either a rubber stamp or the ask-user gate.
 *
 * `spec.ask` is non-null only when the run's permission mode is `default`,
 * which is the mode that means "ask me". Under `acceptEdits` this stays the
 * rubber stamp it has always been.
 *
 * Reading is never asked about. With `settingSources: []` there are no
 * permission rules to pre-approve anything, so in `default` mode the harness
 * escalates every tool -- including Read, Glob and Grep. Asking permission to
 * read a file inside the node's own worktree is forty questions before the
 * first interesting one, and it is already the tool set a frozen node gets
 * unsupervised (D18). Approving those here keeps the questions to the actions
 * that actually change something.
 *
 * No `updatedInput` on the allow path. It is optional, and it REPLACES the
 * tool's input when present -- the previous `updatedInput: {}` was a loaded
 * gun that happened not to have gone off.
 */
function gate(spec: RunSpec): CanUseTool {
  const allow = { behavior: 'allow' as const };
  return (toolName, input, options) => {
    if (spec.ask === null || (READ_ONLY_TOOLS as readonly string[]).includes(toolName)) {
      return Promise.resolve(allow);
    }
    // A parked question outlives nothing: cancelling the node aborts the run,
    // and the pipeline resolves the promise so this returns rather than hangs.
    if (options.signal.aborted) {
      return Promise.resolve({ behavior: 'deny' as const, message: 'the run was stopped' });
    }
    return spec
      .ask({ toolName, detail: describeToolInput(input) })
      .then((decision) =>
        decision.allow ? allow : { behavior: 'deny' as const, message: decision.reason },
      );
  };
}

/**
 * Appended to the Claude Code preset rather than replacing it: the preset is
 * what makes the file and search tools behave well, and D15 chose this SDK
 * precisely for that.
 */
/**
 * The prompt, with the node's success criteria attached.
 *
 * Appended to the message rather than to the system prompt, deliberately. The
 * system prompt is kept identical across every node so it stays cacheable
 * across sessions (see excludeDynamicSections above); putting per-node text in
 * it would make every node pay full price for its own copy.
 *
 * Repeated on every run of the node, not only the first. A later message
 * ("actually, use a set here") should not quietly drop the definition of done.
 */
function promptWithCriteria(spec: RunSpec): string {
  if (spec.successCriteria === null && spec.verificationHint === null) return spec.prompt;

  const parts = [spec.prompt, '', '---', '', 'Definition of done for this node:'];
  if (spec.successCriteria !== null) parts.push('', `What should be true: ${spec.successCriteria}`);
  if (spec.verificationHint !== null) parts.push('', `How to check it: ${spec.verificationHint}`);
  parts.push(
    '',
    'Before you finish, actually run the check and put the result in a `## Testing`',
    'section of CONTEXT.md. Name the command you ran and quote what it printed --',
    '"Ran pytest tests/ -- 12 passed, 0 failed" is useful; "verified, works" is not.',
    'If you could not run it, say exactly what stopped you.',
  );
  return parts.join('\n');
}

const SYSTEM_APPEND = `
You are working inside one node of Bonsai, a tree of coding experiments. This
directory is your own git worktree and nothing you do here affects any other node.

Bonsai owns git. Do not commit, branch, check out, merge, or reset — those are
blocked, and the app commits your work for you when you finish. Read-only git
(status, diff, log) is available and useful.

When you have changed files, write a short CONTEXT.md in the working directory
as your final action: what you were asked for, what you did, and anything a
later node continuing from here should know. If you only answered a question and
changed no files, do not create CONTEXT.md.

If the message gives you a definition of done, run the check yourself and add a
\`## Testing\` section to CONTEXT.md recording the command you ran and what it
actually printed. Report a failure as a failure — a node that honestly says the
tests fail is far more useful than one that says it verified something it did
not. Never claim to have run something you did not run.
`.trim();

/**
 * Totals for a finished run.
 *
 * Reads `modelUsage`, not `usage`. The SDK is explicit that `usage` is the main
 * agent loop only -- it excludes subagents and sidechains -- and that modelUsage
 * is "the correct field for token/cost accounting". Using `usage` made the token
 * counts quietly disagree with the cost sitting next to them.
 *
 * Cache tokens are reported separately because they are most of the answer to
 * "why did that cost what it did": a forked child replays its whole ancestor
 * chain (PRD §11), and replayed context read from cache costs a fraction of
 * fresh input.
 */
function usageEvent(message: {
  total_cost_usd: number;
  usage: { input_tokens?: number; output_tokens?: number };
  modelUsage?: Record<string, ModelUsage>;
}): RunEvent {
  const entries = Object.entries(message.modelUsage ?? {});

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  for (const [, usage] of entries) {
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    cacheReadTokens += usage.cacheReadInputTokens ?? 0;
    cacheCreationTokens += usage.cacheCreationInputTokens ?? 0;
  }

  // The model that did the most output is the one worth naming; subagents and
  // internal calls (compaction, and so on) also appear here.
  const primary = entries.sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0))[0];

  return {
    type: 'done',
    costUsd: message.total_cost_usd ?? 0,
    inputTokens: entries.length > 0 ? inputTokens : (message.usage?.input_tokens ?? 0),
    outputTokens: entries.length > 0 ? outputTokens : (message.usage?.output_tokens ?? 0),
    cacheReadTokens,
    cacheCreationTokens,
    model: primary === undefined ? null : (primary[1].canonicalModel ?? primary[0]),
  };
}

/** A one-line summary of a tool call, for the canvas and the transcript. */
function describeToolInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'pattern', 'command', 'url', 'query']) {
    const value = o[key];
    if (typeof value === 'string') {
      return value.length > 120 ? `${value.slice(0, 117)}...` : value;
    }
  }
  return '';
}
