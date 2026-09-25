import type { ToolResultContent } from '@bonsai/shared';

/**
 * What the agent did between two things it said, in words.
 *
 * A run of tool calls is shown as one dimmed line -- "Read chunk_writer.py,
 * ran 2 commands" -- that opens into a row per step. This module is the
 * wording: which verb a call gets, what it is called, and how a stretch of
 * calls becomes one sentence. Pure, so it is tested without a browser.
 *
 * `**text**` marks the part a line lifts (a file name), the way the rows draw
 * it; nothing else in the output is markup.
 */

/** One tool call, as the conversation recorded it. */
export interface StepInput {
  name: string;
  detail: string;
  /** What the agent said the call is for, when it said. */
  description?: string | undefined;
  result: ToolResultContent | undefined;
  /** The step is still running. */
  live: boolean;
  /** A better name than the path, such as `@smoke-test` for a reference. */
  subject?: string | undefined;
  /** Set when a subagent made the call, naming the call that started it. */
  parentToolUseId?: string | undefined;
}

export type StepKind =
  'read' | 'create' | 'edit' | 'command' | 'search' | 'fetch' | 'ask' | 'other';

export interface Step extends StepInput {
  kind: StepKind;
  /** The row's words: "Created **test_x.py**", or a command's purpose. */
  label: string;
  added: number;
  removed: number;
  failed: boolean;
}

const COMMANDS = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash']);
const CHANGES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SEARCHES = new Set(['Grep', 'Glob']);
const FETCHES = new Set(['WebFetch', 'WebSearch']);

/** Which kind of step a call is, from what it produced before its name. */
export function stepKind(name: string, result: ToolResultContent | undefined): StepKind {
  if (result?.edit !== undefined) {
    return name === 'Write' && result.edit.removed === 0 ? 'create' : 'edit';
  }
  if (result?.output !== undefined || COMMANDS.has(name)) return 'command';
  if (name === 'Write') return 'create';
  if (CHANGES.has(name)) return 'edit';
  if (name === 'Read') return 'read';
  if (SEARCHES.has(name)) return 'search';
  if (FETCHES.has(name)) return 'fetch';
  if (name === 'AskUserQuestion') return 'ask';
  return 'other';
}

/** The last part of a path: a row names the file, and the full path is one click away. */
export function fileName(path: string): string {
  return (
    path
      .split(/[\\/]/)
      .filter((part) => part !== '')
      .at(-1) ?? path
  );
}

/** The whole step, worded for its row. */
export function toStep(input: StepInput): Step {
  const kind = stepKind(input.name, input.result);
  const edit = input.result?.edit;
  const file = `**${input.subject ?? fileName(edit?.path ?? input.detail)}**`;
  const label = (() => {
    switch (kind) {
      case 'read':
        return `Read ${file}`;
      case 'create':
        return `Created ${file}`;
      case 'edit':
        return `Edited ${file}`;
      case 'command':
        return input.description ?? `Ran **${clip(input.detail, 60)}**`;
      case 'search':
        return `Searched for **${clip(input.detail, 60)}**`;
      case 'fetch':
        return input.name === 'WebSearch'
          ? `Searched the web for **${clip(input.detail, 60)}**`
          : `Fetched **${clip(input.detail, 60)}**`;
      case 'ask':
        return 'Asked you a question';
      default:
        return input.detail === ''
          ? `Used ${input.name}`
          : `Used ${input.name} on **${clip(input.detail, 60)}**`;
    }
  })();
  return {
    ...input,
    kind,
    label,
    added: edit?.added ?? 0,
    removed: edit?.removed ?? 0,
    failed: input.result !== undefined && !input.result.ok,
  };
}

/**
 * A stretch of steps as one sentence: what happened to files first, by name
 * when there is one of a kind, then how many commands ran and searches were
 * made. "Read **chunk_writer.py**, ran a command". "Edited 3 files, ran 2
 * commands".
 */
export function summarise(steps: readonly Step[]): string {
  const parts: string[] = [];
  const files = (kind: StepKind, verb: string): void => {
    const named = [...new Set(steps.filter((s) => s.kind === kind).map((s) => labelTarget(s)))];
    if (named.length === 1) parts.push(`${verb} ${named[0]}`);
    else if (named.length > 1) parts.push(`${verb} ${named.length} files`);
  };
  files('create', 'created');
  files('edit', 'edited');
  files('read', 'read');
  const count = (kind: StepKind, one: string, many: (n: number) => string): void => {
    const n = steps.filter((s) => s.kind === kind).length;
    if (n === 1) parts.push(one);
    else if (n > 1) parts.push(many(n));
  };
  count('command', 'ran a command', (n) => `ran ${n} commands`);
  count('search', 'searched the code', (n) => `searched ${n} times`);
  count('fetch', 'looked something up', (n) => `looked ${n} things up`);
  count('ask', 'asked you a question', (n) => `asked you ${n} questions`);
  count('other', 'used a tool', (n) => `used ${n} tools`);
  const sentence = parts.join(', ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * What a running stretch says while it runs: the step in progress, in the
 * present tense. "Running **pytest -q**" -- the line pulses while it runs,
 * so it needs no trailing dots to say so.
 */
export function runningLabel(step: Step): string {
  switch (step.kind) {
    case 'command':
      return `Running **${clip(step.detail, 60)}**`;
    case 'read':
      return `Reading ${labelTarget(step)}`;
    case 'create':
    case 'edit':
      return `Writing ${labelTarget(step)}`;
    case 'search':
      return `Searching for **${clip(step.detail, 60)}**`;
    case 'fetch':
      return `Looking up **${clip(step.detail, 60)}**`;
    case 'ask':
      return 'Asking you a question';
    default:
      return `Using ${step.name}`;
  }
}

/** The lifted name in a file step's label, markup included. */
function labelTarget(step: Step): string {
  return /\*\*.*\*\*/.exec(step.label)?.[0] ?? step.label;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Split `**lifted**` markup into runs, for drawing. */
export function segments(text: string): Array<{ text: string; lifted: boolean }> {
  return text
    .split('**')
    .map((part, i) => ({ text: part, lifted: i % 2 === 1 }))
    .filter((part) => part.text !== '');
}

/** A line of command output that reads as a failure, drawn in the failure colour. */
export function isFailureLine(line: string): boolean {
  return /^(E |>|FAIL|ERROR|Error|error:|Traceback)|\bFAILURES?\b|\bfailed\b/.test(line);
}
