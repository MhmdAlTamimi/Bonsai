/**
 * A response the server refused, carrying the status it refused with.
 *
 * Its own module, away from the fetch client, for two reasons. describeError
 * needs the class and nothing else, and importing the client would drag
 * EventSource and every endpoint into a pure string helper. And written with
 * ordinary field assignment rather than TypeScript parameter properties, so
 * the file runs under Node's type stripping — which is what lets it be tested
 * without a browser or a bundler.
 */
export class ApiCallError extends Error {
  readonly status: number;
  readonly milestone: string | undefined;

  constructor(message: string, status: number, milestone?: string) {
    super(message);
    this.name = 'ApiCallError';
    this.status = status;
    this.milestone = milestone;
  }
}
