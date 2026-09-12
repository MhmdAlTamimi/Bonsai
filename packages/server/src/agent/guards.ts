import type {
  HookCallbackMatcher,
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * What the agent is allowed to do.
 *
 * Two layers, and they are not equally strong. `allowedTools` is enforced by
 * the SDK -- a tool that is not listed cannot be called at all. The git hook
 * below only inspects Bash command strings, which is weaker; see the honesty
 * note on MUTATING_GIT.
 */

/** D18/D26: frozen and conversation-only runs get no way to change anything. */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'] as const;

/**
 * There is deliberately no WRITABLE_TOOLS list.
 *
 * One used to live here, and it was a latent bug: `allowedTools` doubles as the
 * pre-approval list, so every tool the agent might reach for had to be named
 * exactly right, and anything the harness offered under a name Bonsai did not
 * know was silently unavailable -- the agent could not edit, and the run
 * finished "successfully" having committed nothing. Writable runs approve tools
 * through canUseTool instead, so no list has to track the SDK.
 */

/**
 * D30 refines D19: the agent is blocked from MUTATING git, not from reading it.
 * `status`, `diff` and `log` are allowed and are needed for interrupted-run
 * recovery, so a blanket block would break M4.
 */
const MUTATING_GIT = [
  'commit',
  'branch',
  'checkout',
  'switch',
  'merge',
  'rebase',
  'reset',
  'restore',
  'cherry-pick',
  'revert',
  'stash',
  'tag',
  'push',
  'pull',
  'fetch',
  'clean',
  'worktree',
  'update-ref',
  'am',
  'apply',
  'gc',
  'prune',
];

/**
 * True if a shell command looks like it mutates git.
 *
 * HONEST ABOUT ITS LIMITS. This inspects a command string, so it is a
 * speed bump and not a sandbox: `g=git; $g commit`, `sh -c '...'`, an alias, or
 * a script file all walk straight past it. It catches the case D19 actually
 * worried about -- an agent committing or branching behind the app's back --
 * and nothing more.
 *
 * The guarantee comes from elsewhere: after every run the app compares the
 * branch head against what it expected, so a commit the agent slipped through
 * is detected and folded back rather than silently corrupting the tree. And
 * working-tree destruction (`rm -rf`, and the git verbs above that touch no
 * ref) is neither blocked nor recoverable -- V0 is a visualizer of experiments,
 * not a sandbox, and pretending otherwise would be the same overclaim D18 makes.
 */
export function mutatesGit(command: string): boolean {
  // Split on shell separators so `ls && git commit` is inspected as two commands.
  for (const part of command.split(/(?:&&|\|\||[;|\n])/)) {
    const tokens = part.trim().split(/\s+/);
    const gitAt = tokens.findIndex((t) => t === 'git' || t.endsWith('/git'));
    if (gitAt === -1) continue;

    // Skip git's own flags (-C <path>, -c k=v, --git-dir=...) to find the verb.
    let i = gitAt + 1;
    while (i < tokens.length) {
      const token = tokens[i]!;
      if (token === '-C' || token === '-c') i += 2;
      else if (token.startsWith('-')) i += 1;
      else break;
    }
    const verb = tokens[i];
    if (verb !== undefined && MUTATING_GIT.includes(verb)) return true;
  }
  return false;
}

/**
 * A PreToolUse hook that denies mutating git before it runs.
 *
 * The app owns the repo (D8) and commits on the agent's behalf (D28). An agent
 * creating branches on its own would corrupt the tree, which is why this is a
 * deny rather than an instruction.
 */
export function gitGuardHook(): HookCallbackMatcher {
  return {
    matcher: 'Bash',
    hooks: [
      // Not `async`: the SDK's hook signature wants a promise and this decides
      // synchronously, so the promise is made explicitly rather than implied.
      (input): Promise<HookJSONOutput> => {
        const pre = input as PreToolUseHookInput;
        const command = (pre.tool_input as { command?: unknown } | undefined)?.command;
        if (typeof command === 'string' && mutatesGit(command)) {
          return Promise.resolve({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason:
                'Bonsai owns this repository. Read-only git (status, diff, log) is fine, ' +
                'but committing, branching, checking out, merging or resetting is not — ' +
                'the app commits your work for you when the run finishes.',
            },
          });
        }
        return Promise.resolve({ continue: true });
      },
    ],
  };
}
