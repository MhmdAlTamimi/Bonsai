import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Whether the Claude Agent SDK has some way to authenticate (D23: both an API
 * key and subscription login are supported).
 *
 * Open Question 5 asked which path wins when both are configured. Answered by
 * not choosing: the SDK resolves credentials itself, in its own documented
 * order. This decides only whether to attempt a real run at all, so a checkout
 * with no credentials degrades to the stand-in instead of failing every run
 * with an auth error the user cannot act on from the canvas.
 *
 * DELIBERATELY CONSERVATIVE, and the reason is a bug this already had: an
 * earlier version treated ~/.claude.json as proof of credentials. That file is
 * Claude Code's config and exists on any machine where Claude Code has ever
 * run, so the check passed on machines with no credentials at all -- turning
 * the graceful fallback into a guaranteed failure. Only stores that actually
 * hold a credential count now.
 *
 * The remaining gap is a false negative: on macOS a subscription login is kept
 * in the Keychain, which is not visible here. BONSAI_REAL_AGENT=1 forces the
 * real runner for exactly that case. A false negative costs a env var; a false
 * positive costs every run.
 */
export function hasAgentCredentials(): boolean {
  if (process.env['BONSAI_REAL_AGENT'] === '1') return true;

  if (process.env['ANTHROPIC_API_KEY']) return true;
  if (process.env['ANTHROPIC_AUTH_TOKEN']) return true;
  if (process.env['CLAUDE_CODE_OAUTH_TOKEN']) return true;

  const home = homedir();
  return (
    // A subscription login writes this; Claude Code's ~/.claude.json does NOT
    // imply it and must not be treated as a credential.
    existsSync(join(home, '.claude', '.credentials.json')) ||
    // `ant auth login` profiles.
    existsSync(join(home, '.config', 'anthropic', 'auth.json'))
  );
}
