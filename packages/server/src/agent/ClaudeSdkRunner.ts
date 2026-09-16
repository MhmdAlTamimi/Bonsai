import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  EffortLevel,
  ModelUsage,
  Options,
  PermissionMode,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentQuestion } from '@bonsai/shared';

import type { AgentRunner, RunEvent, RunSpec } from './AgentRunner.js';
import { READ_ONLY_TOOLS, gitGuardHook } from './guards.js';
import { Inbox, SessionActivity } from './session.js';
import { RUN_MARKER } from '../jobs/leftovers.js';

/**
 * D15: the Claude Agent SDK, not the raw API -- the same harness as Claude Code,
 * so file editing, search and bash are already reliable.
 *
 * Everything milestone-specific lives above this class. The run pipeline already
 * decides when to commit, when to freeze and what a node's git base is; this
 * only turns a RunSpec into a query() and its messages into RunEvents.
 */
export class ClaudeSdkRunner implements AgentRunner {
  /** The SDK's `query`, unless a test supplies a scripted one. */
  constructor(private readonly startQuery: StartQuery = query) {}

  async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    if (spec.signal.aborted) return;
    const controller = new AbortController();
    const inbox = new Inbox();
    const session = new SessionActivity({
      report: spec.onActivity,
      end: () => inbox.close(),
      say: (text) => inbox.send(text),
      leftovers: spec.backgroundLeftovers,
    });
    let live: SessionQuery | null = null;

    // Stop: the jobs it started are stopped through the harness first, which
    // ends their whole process trees, and only then is the session killed.
    const stop = (): void => {
      void stopJobs(live, session).finally(() => controller.abort());
    };
    // Finish now: the same jobs stopped, but the session is closed rather than
    // killed, so the turn in progress completes and the run ends normally.
    const finish = (): void => {
      session.finish();
      void stopJobs(live, session).finally(() => inbox.close());
    };
    spec.signal.addEventListener('abort', stop, { once: true });
    spec.finishNow.addEventListener('abort', finish, { once: true });

    const options: Options = {
      // D17: the worktree is the isolation boundary. Every node has one,
      // including the conversation-only ones.
      cwd: spec.cwd,
      abortController: controller,

      // Which tools may run, and who decides. See `permissionOptions`.
      ...permissionOptions(spec),
      // A key stored in Settings reaches the subprocess here rather than being
      // written into this process's environment. The run's marker rides along
      // into everything the agent starts, detached processes included, which
      // is how Bonsai finds work the harness is not tracking (D43).
      env: { ...process.env, ...spec.agentEnv, [RUN_MARKER]: spec.runId },
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
      // D43: a stream, not a string, so the session outlives the first turn.
      // See `Inbox` for what the string version did to background commands.
      inbox.send(promptWithCriteria(spec));
      live = this.startQuery({ prompt: inbox, options });

      for await (const message of live) {
        // session_id rides every message. A forked run gets a NEW one, which is
        // the id this node must store -- storing the parent's would make later
        // chats on this node write into the parent's conversation.
        if (!sessionAnnounced && 'session_id' in message && message.session_id) {
          sessionAnnounced = true;
          yield { type: 'session', sessionId: message.session_id };
        }

        if (message.type === 'system') {
          if (message.subtype === 'init') {
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
          } else if (message.subtype === 'background_tasks_changed') {
            session.jobsChanged(message.tasks);
          } else if (message.subtype === 'thinking_tokens') {
            session.thinking();
          }
        } else if (message.type === 'assistant') {
          // A subagent's messages carry the tool call that started it. They
          // are shown, but they are not the agent taking a turn.
          const main = message.parent_tool_use_id === null;
          if (main) session.turnStarted();
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text.trim() !== '') {
              yield { type: 'text', text: block.text };
            } else if (block.type === 'tool_use') {
              const detail = describeToolInput(block.input);
              if (main) session.toolStarted(block.id, block.name, detail);
              yield { type: 'tool', name: block.name, detail };
            }
          }
        } else if (message.type === 'user') {
          const content = message.message.content;
          if (message.parent_tool_use_id === null && Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') session.toolFinished(block.tool_use_id);
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
          // D20: cost and tokens captured per run from day one. Every turn's
          // result carries the running total, so each one replaces the last.
          yield usageEvent(message);
          // D43: the end of a turn is the end of the run only when nothing it
          // started is still running.
          if (await session.turnEnded(message.queued_turn_count ?? 0)) inbox.close();
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return; // cancellation is not a failure
      throw err;
    } finally {
      spec.signal.removeEventListener('abort', stop);
      spec.finishNow.removeEventListener('abort', finish);
      session.dispose();
      inbox.close();
    }
  }
}

/** Starts a session. The SDK's `query`, narrowed to what a run uses. */
export type StartQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => SessionQuery;

export type SessionQuery = AsyncIterable<SDKMessage> & Pick<Query, 'stopTask'>;

/** How long Stop and Finish now wait for the harness to stop jobs before going ahead. */
const STOP_JOBS_MS = 2_000;

/**
 * Stops every tracked job through the harness, which ends each one's process
 * tree and tells the agent it was stopped. Bounded, because a harness that
 * does not answer must not turn Stop into a hang.
 */
async function stopJobs(live: SessionQuery | null, session: SessionActivity): Promise<void> {
  const ids = session.liveJobIds();
  if (live === null || ids.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled(ids.map((id) => live.stopTask(id))),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, STOP_JOBS_MS);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * Which tools a run may use, and what decides.
 *
 * Two different jobs, so two different shapes.
 *
 * WRITABLE runs keep the project's permission mode and get an approval
 * callback. An allow-list was a latent bug here: it doubles as the
 * pre-approval list, so any tool the harness offers under a name Bonsai does
 * not know was silently unavailable -- the agent could not edit, said so in
 * prose, and the run completed "successfully" having committed nothing.
 * `canUseTool` approves whatever the harness offers, so Bonsai never keeps a
 * list of tool names in step with the SDK. The git hook still blocks mutating
 * git, and the callback is also where a run stops to ask (D34, see `gate`).
 *
 * READ-ONLY runs -- frozen experiments, and an adopted project's master, whose
 * folder is the user's own checkout -- are where this used to be wrong. They
 * were given `allowedTools` alone, on the belief that "a tool that is not
 * named cannot be called at all". It can. `allowedTools` only PRE-APPROVES;
 * under `acceptEdits`, the app's default mode, the mode itself approves writes
 * before any list or callback is consulted. Verified against the real SDK: a
 * run configured exactly that way created a file when asked to, and a real
 * read-only run on an adopted project's master ran `Bash` in the user's own
 * folder. It only happened to run `find` and `grep`.
 *
 * So read-only is enforced by the callback, and the mode is forced to
 * `default` so nothing is approved before the callback sees it: reads are
 * pre-approved, and every other tool -- including ones a future SDK adds -- is
 * denied. Deny by default is the only version of this that stays true when the
 * harness grows a tool.
 */
export function permissionOptions(
  spec: RunSpec,
): Pick<Options, 'permissionMode' | 'allowedTools' | 'canUseTool' | 'hooks'> {
  if (spec.readOnly) {
    return {
      // Whatever the project chose. `acceptEdits` and `bypassPermissions`
      // exist to approve changes, and a read-only run makes none.
      permissionMode: 'default',
      allowedTools: [...READ_ONLY_TOOLS],
      canUseTool: readOnlyGate(spec),
    };
  }
  return {
    permissionMode: spec.permissionMode as PermissionMode,
    canUseTool: gate(spec),
    // D19/D30: the app owns git. Read-only git stays available for recovery.
    hooks: { PreToolUse: [gitGuardHook()] },
  };
}

/** Said to the agent when a read-only run reaches for anything that could change something. */
export const READ_ONLY_REFUSAL =
  'This experiment is read-only: its code is frozen, or its folder is the user’s own. ' +
  'You can read, search and answer questions here. To change anything, say what you would ' +
  'change and the user can branch a new experiment for it.';

/**
 * Reads go through, and so does a question to the user; everything else is
 * refused, named or not. Asking changes nothing, so a frozen experiment -- or
 * your own folder -- may still ask you something (D42).
 */
export function readOnlyGate(spec: RunSpec): CanUseTool {
  return (toolName, input, options) => {
    if (toolName === ASK_USER_TOOL) return relayQuestion(spec, input, options.signal);
    return Promise.resolve(
      (READ_ONLY_TOOLS as readonly string[]).includes(toolName)
        ? { behavior: 'allow' as const }
        : { behavior: 'deny' as const, message: READ_ONLY_REFUSAL },
    );
  };
}

/** The SDK's name for the agent asking the user something. */
export const ASK_USER_TOOL = 'AskUserQuestion';

/** Told to the agent when the user leaves the decision to it. */
export const NO_ONE_TO_ASK =
  'No one is available to answer this question. Decide yourself, and say clearly in your ' +
  'reply what you assumed.';

/**
 * Puts the agent's question to the user and hands the answer back.
 *
 * THE ANSWER TRAVELS IN THE TOOL'S INPUT. The SDK's contract for this tool is
 * that the permission callback returns the input with an `answers` map filled
 * in -- "user answers collected by the permission component" -- and the tool's
 * result is built from that. Approving the call without it is what used to
 * happen: the tool returned at once, with nothing, and the agent wrote "I'll
 * wait for them to answer" into a run that then simply ended. Verified against
 * the real SDK in every permission mode, read-only runs included.
 *
 * Not answering is a refusal carrying a reason, because the SDK delivers a
 * refusal's message to the agent as the tool's result: "decide yourself and
 * say what you assumed" is something it can act on.
 */
export async function relayQuestion(
  spec: RunSpec,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<PermissionResult> {
  if (signal.aborted) return { behavior: 'deny', message: 'the run was stopped' };
  const questions = parseQuestions(input);
  if (questions === null) {
    return {
      behavior: 'deny',
      message:
        'That question could not be shown to the user: it needs 1 to 4 questions, each with a ' +
        'question, a header and 2 to 4 options. Ask again in that shape, or ask in your reply.',
    };
  }
  if (spec.askChoices === null) return { behavior: 'deny', message: NO_ONE_TO_ASK };

  const decision = await spec.askChoices({ questions });
  if (!decision.answered) return { behavior: 'deny', message: decision.reason };
  return { behavior: 'allow', updatedInput: { ...input, answers: decision.answers } };
}

/**
 * The questions, or null when the input is not the shape the tool promises.
 *
 * Checked rather than cast, because this input comes from the model: a
 * malformed question should come back to the agent as something to fix, not
 * reach the panel as something that cannot be rendered or answered.
 */
export function parseQuestions(input: Record<string, unknown>): AgentQuestion[] | null {
  const raw = input['questions'];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) return null;
  const out: AgentQuestion[] = [];
  for (const item of raw as unknown[]) {
    if (item === null || typeof item !== 'object') return null;
    const q = item as Record<string, unknown>;
    if (typeof q['question'] !== 'string' || q['question'].trim() === '') return null;
    if (!Array.isArray(q['options'])) return null;
    const options: AgentQuestion['options'] = [];
    for (const option of q['options'] as unknown[]) {
      if (option === null || typeof option !== 'object') return null;
      const o = option as Record<string, unknown>;
      if (typeof o['label'] !== 'string' || o['label'].trim() === '') return null;
      options.push({
        label: o['label'],
        description: typeof o['description'] === 'string' ? o['description'] : '',
        ...(typeof o['preview'] === 'string' ? { preview: o['preview'] } : {}),
      });
    }
    if (options.length < 2 || options.length > 4) return null;
    out.push({
      question: q['question'],
      header: typeof q['header'] === 'string' ? q['header'] : '',
      multiSelect: q['multiSelect'] === true,
      options,
    });
  }
  // Answers are keyed by question text, so two identical questions could not
  // be answered separately.
  if (new Set(out.map((q) => q.question)).size !== out.length) return null;
  return out;
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
export function gate(spec: RunSpec): CanUseTool {
  const allow = { behavior: 'allow' as const };
  return (toolName, input, options) => {
    // Before anything about permission modes: the agent asking the user
    // something is not an action to approve, so no mode may wave it through
    // unanswered (D42).
    if (toolName === ASK_USER_TOOL) return relayQuestion(spec, input, options.signal);
    if (spec.ask === null || (READ_ONLY_TOOLS as readonly string[]).includes(toolName)) {
      return Promise.resolve(allow);
    }
    // A parked question outlives nothing: cancelling the node aborts the run,
    // and the pipeline resolves the promise so this returns rather than hangs.
    if (options.signal.aborted) {
      return Promise.resolve({ behavior: 'deny' as const, message: 'the run was stopped' });
    }
    return spec
      .ask({
        toolName,
        detail: describeToolInput(input, false),
        details: JSON.stringify(input, null, 2),
      })
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

For a command that takes a long time -- installs, training, batch jobs -- use the
Bash tool's background mode (run_in_background). Never detach a process with
nohup, setsid, disown or a trailing &: nothing would tell you when it ends. Bonsai
keeps this run open while your background commands are running and you are
notified when each one finishes, so end your turn and wait for that notification
instead of polling. The run is committed only after your background work is done.
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
function describeToolInput(input: unknown, truncate = true): string {
  if (input === null || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  // A question has no path or command to summarise it by, so it used to be
  // recorded as a blank line -- and what the agent asked was lost with it.
  const asked = parseQuestions(o);
  if (asked !== null) {
    const text = asked.map((q) => q.question).join(' · ');
    return truncate && text.length > 120 ? `${text.slice(0, 117)}...` : text;
  }
  for (const key of ['file_path', 'path', 'pattern', 'command', 'url', 'query']) {
    const value = o[key];
    if (typeof value === 'string') {
      return truncate && value.length > 120 ? `${value.slice(0, 117)}...` : value;
    }
  }
  return '';
}
