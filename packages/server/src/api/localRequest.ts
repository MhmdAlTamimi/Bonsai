import type { IncomingHttpHeaders } from 'node:http';
import { HttpError } from './http.js';
const loopback = (host: string): boolean =>
  ['localhost', '127.0.0.1', '[::1]'].includes(host.toLowerCase());

/**
 * The bodies a web page on another site can send without the browser asking
 * first (a CORS "simple" request): a form post, or fetch with a string body.
 * Bonsai's own interface only ever sends JSON, so a change arriving as one of
 * these did not come from it.
 */
const SIMPLE_BODIES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];

/**
 * Local API capability boundary, independent of browser CORS enforcement.
 *
 * The Host check stops DNS rebinding (a remote name pointed at 127.0.0.1), the
 * Origin check stops another site's page, and the body type is the second
 * lock on that door for any client that leaves Origin out.
 */
export function assertLocalRequest(headers: IncomingHttpHeaders, method = 'GET'): void {
  try {
    if (!headers.host || !loopback(new URL(`http://${headers.host}`).hostname)) throw new Error();
    if (headers.origin && !loopback(new URL(headers.origin).hostname)) throw new Error();
  } catch {
    throw new HttpError(403, 'Bonsai accepts requests from local applications only.');
  }
  const type = headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && type && SIMPLE_BODIES.includes(type))
    throw new HttpError(415, 'Bonsai accepts changes as JSON only.');
}
