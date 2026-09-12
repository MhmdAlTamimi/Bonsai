import { ApiCallError } from './ApiCallError.ts';

/**
 * Turns anything that can be thrown into a sentence a person can act on.
 *
 * The places in this app that were thought about are good — the read-only
 * folder explanation, the tracked-file refusal — and the places that were not
 * put `TypeError: Failed to fetch` in a banner, which tells the user nothing
 * except that something is broken and they are on their own. This is the one
 * helper both kinds go through.
 *
 * TWO RULES, and the second is the one worth keeping.
 *
 * A message the SERVER wrote is passed through untouched. Those are written
 * for this user about this situation ("This folder is the node try Redis in
 * your project API rewrite"), and a generic replacement would be strictly
 * worse. Only the status codes get a sentence of their own, because a status
 * code is not a message.
 *
 * And every sentence says what to do next. "Not connected" is a fact; "Open
 * Settings and sign in" is a fact plus a way out, and the difference is
 * whether the user is stuck.
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiCallError) return describeApiError(error);

  /**
   * A fetch that never reached the server. The browser's own text for this is
   * "TypeError: Failed to fetch", which is true and useless: the overwhelmingly
   * likely cause on a local app is that the server is no longer running.
   */
  if (error instanceof TypeError) {
    return 'Could not reach the Bonsai server. It may have stopped — check the terminal you started it in, then reload.';
  }

  if (error instanceof Error) return error.message;
  // A thrown string is usually a message someone meant to be read.
  if (typeof error === 'string' && error.trim() !== '') return error;

  /**
   * Anything else -- a thrown object, null, a rejected promise with no reason.
   * `String(x)` here produced "[object Object]" on screen, which is the exact
   * failure this helper exists to prevent, so the fallback is a sentence.
   */
  return 'Something went wrong, and Bonsai could not tell what. Settings has a "Copy diagnostics" button if it keeps happening.';
}

function describeApiError(error: ApiCallError): string {
  switch (error.status) {
    /**
     * 428 is the connection gate. The server's message names the actual reason
     * -- no CLI, expired token, rate limited -- so it leads, and the way out
     * is appended rather than replacing it.
     */
    case 428:
      return `${error.message} Open Settings to sign in or add an API key.`;

    /** 409 is "already running", the only conflict the API raises. */
    case 409:
      return `${error.message} Wait for it to finish, or press Stop.`;

    case 404:
      return `${error.message} It may have been deleted — reload to see what is still there.`;

    /** 501 is a route that exists in the contract but has not been built. */
    case 501:
      return error.milestone === undefined
        ? `${error.message} That part is not built yet.`
        : `${error.message} (not built yet)`;

    /**
     * 400 is validation, and the server's message is the specific complaint --
     * which path was rejected and why. Nothing generic improves on it.
     */
    case 400:
      return error.message;

    case 500:
      return `${error.message} If it keeps happening, Settings has a "Copy diagnostics" button that gathers everything needed to look into it.`;

    default:
      return error.message;
  }
}
