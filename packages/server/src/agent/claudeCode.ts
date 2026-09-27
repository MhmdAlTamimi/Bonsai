import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Claude Code Bonsai actually runs.
 *
 * Not the `claude` on your PATH: the Agent SDK carries its own copy, and every
 * run, comparison and draft uses that one. So its version is set by Bonsai's
 * @anthropic-ai/claude-agent-sdk dependency, and `claude update` does not
 * change it -- which is worth saying, because Claude Code's own errors
 * suggest exactly that.
 */
let cached: string | null | undefined;
export function bundledClaudeCodeVersion(): string | null {
  if (cached !== undefined) return cached;
  try {
    const entry = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
    const manifest = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as {
      claudeCodeVersion?: unknown;
    };
    cached = typeof manifest.claudeCodeVersion === 'string' ? manifest.claudeCodeVersion : null;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Claude Code's error, with advice that works inside Bonsai. Anything else is
 * returned as it came.
 */
export function explainAgentError(message: string, version = bundledClaudeCodeVersion()): string {
  const needed = /does not support this model; version (\S+?) or newer is required/i.exec(message);
  if (needed === null) return message;
  return (
    `This model needs Claude Code ${needed[1]} or newer. Bonsai runs the Claude Code bundled ` +
    `with its Agent SDK${version === null ? '' : ` (${version})`}, not the one \`claude update\` ` +
    'updates, so update Bonsai (its @anthropic-ai/claude-agent-sdk dependency) or choose another ' +
    'model in Settings.'
  );
}
