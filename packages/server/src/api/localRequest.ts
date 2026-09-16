import type { IncomingHttpHeaders } from 'node:http';
import { HttpError } from './http.js';
const loopback = (host: string): boolean =>
  ['localhost', '127.0.0.1', '[::1]'].includes(host.toLowerCase());
/** Local API capability boundary, independent of browser CORS enforcement. */
export function assertLocalRequest(headers: IncomingHttpHeaders): void {
  try {
    if (!headers.host || !loopback(new URL(`http://${headers.host}`).hostname)) throw new Error();
    if (headers.origin && !loopback(new URL(headers.origin).hostname)) throw new Error();
  } catch {
    throw new HttpError(403, 'Bonsai accepts requests from local applications only.');
  }
}
