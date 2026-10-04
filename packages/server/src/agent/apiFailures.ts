import type { SDKAPIRetryMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

export function resultFailure(message: SDKResultMessage): string {
  const detail =
    'errors' in message && message.errors.length > 0
      ? message.errors.join('; ')
      : 'result' in message && message.result.trim()
        ? message.result
        : `Claude Code ended with ${message.subtype}`;
  return terminalApiFailure(detail) ?? detail;
}

/** SDK failure categories are stronger evidence than guessing from arbitrary task text. */
export function terminalApiFailure(error: string, status: number | null = null): string | null {
  if (
    error === 'billing_error' ||
    /credit balance|billing error|billing_error|account_on_hold|verification_required|oauth_org_not_allowed/i.test(
      error,
    )
  )
    return 'Claude rejected this account: billing, account access or verification needs attention. Check your Claude account before retrying.';
  if (
    status === 401 ||
    status === 403 ||
    /authentication_failed|\b401\b|\b403\b|invalid (?:x-api-key|api key)|unauthorized|not logged in|credential.*expired/i.test(
      error,
    )
  )
    return 'Claude rejected the credential (authentication or access denied). Sign in again or replace the API key in Settings.';
  return null;
}

/** Bound an outage rather than letting the SDK retry for several minutes in silence. */
export class ApiRetryGuard {
  error: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private count = 0;
  private started = 0;
  constructor(
    private readonly controller: AbortController,
    private readonly budgetMs = 30_000,
  ) {}
  retry(message: SDKAPIRetryMessage): { text: string; retryAt: string } {
    this.count += 1;
    const failure = terminalApiFailure(message.error, message.error_status);
    if (this.started === 0) {
      this.started = Date.now();
      this.timer = setTimeout(
        () =>
          this.fail(
            'Claude is still unavailable after 30 seconds of retries. Your partial work is preserved. Retry the run when the connection recovers.',
          ),
        this.budgetMs,
      );
      this.timer.unref();
    }
    if (failure !== null) this.fail(failure);
    else if (this.count > 3 || Date.now() - this.started + message.retry_delay_ms > this.budgetMs)
      this.fail(
        `Claude is unavailable (${message.error_status ?? message.error}). Retry limit reached; partial work is preserved.`,
      );
    return {
      text:
        this.error ??
        `Claude connection retry ${this.count}/3 (${message.error_status ?? message.error}); next attempt in ${Math.ceil(message.retry_delay_ms / 1000)} s.`,
      retryAt: new Date(Date.now() + message.retry_delay_ms).toISOString(),
    };
  }
  private fail(message: string): void {
    this.error = message;
    this.controller.abort();
  }
  recovered(): void {
    this.dispose();
    this.count = 0;
    this.started = 0;
  }
  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
