# Audit phase 1 — the server shell

2026-09-29, `main` at 5842b8c. Startup and shutdown, configuration and the data
folder, settings, logging, the HTTP layer and who may call it.

Files: `index.ts`, `config.ts`, `settings.ts`, `log.ts`, `api/http.ts`,
`api/routing.ts`, `api/router.ts`, `api/localRequest.ts`, `api/events.ts`,
`api/routes/system.ts`.

## How it works

`index.ts` does its work at module load, in this order: read the config (data
folder per platform, port 8787), open the log, open and migrate the database,
read `settings.json`, build the store, the event bus, the run and comparison
job queues, and start the idle-folder archiver. Then it checks the Claude
connection in the background, **marks every run still recorded as running as
failed ("app closed")**, backfills hidden refs in the background, and only then
calls `listen` on 127.0.0.1.

Each request goes to `handleApi` for `/api/*` or to the built interface
otherwise. `handleApi` first applies `assertLocalRequest` — the Host must be a
loopback name (stops DNS rebinding), a present Origin must be loopback (stops
other web pages), and a change must not arrive as a form or plain-text body
(stops the one kind of cross-site request a browser sends without asking). It
then matches the route table, which the files in `api/routes/` fill as they are
imported, and turns thrown `HttpError`s into JSON errors; anything else is a
logged 500.

SIGINT and SIGTERM close the event streams, stop accepting connections, cancel
every run, wait up to 3 s for them to unwind, close the database and exit.

## Findings

### S1 · High · verified — Two copies of Bonsai on one data folder corrupt each other's runs

Nothing stops a second copy from starting on the same data folder, and startup
recovery runs before the port is claimed (`index.ts:84` runs, `index.ts:161`
listens, and there is no `error` handler on the server).

Run twice — `npm start` in a second terminal, or `npm run dev` while `npm
start` is open, both on port 8787 — and the second copy, before it crashes:

1. marks the first copy's live run as *failed — app closed* and its experiment
   *interrupted*, while the run is still going;
2. crashes with a raw Node stack trace (`EADDRINUSE`) instead of a sentence.

A second copy on another port (`BONSAI_PORT`) with the same data folder is
worse: it runs normally, and accepted a second run on an experiment the first
copy was still running — two agents in one folder. In the test the second run
failed on Bonsai's own ref check, and the experiment ended *interrupted* with
"This experiment's Git state changed outside Bonsai", although nothing outside
Bonsai touched it and the first run had finished and committed.

Reproduce: `npm run build:server && node scripts/audit/two-instances.mjs`.

**Fix (S).** Take an exclusive lock on the data folder before touching the
database: a `bonsai.lock` holding the PID and port, created with `O_EXCL`,
replaced only when that PID is no longer running. When another copy holds it,
print "Bonsai is already running at http://localhost:8787", open that address
if `--open` was given, and exit 0. Separately, turn a port taken by another
program into one sentence naming `BONSAI_PORT`.

### S2 · Medium · by reading — One unexpected error stops everything, and leaves no trace in the log

There is no `unhandledRejection` or `uncaughtException` handler. In Node 22 a
single rejected promise that nothing catches ends the process: every running
agent stops, the page says the server is unreachable, and nothing restarts it.
The cause is printed to the terminal only, so the log file — which is what
**Copy diagnostics** collects — never shows why Bonsai died.

The code is careful at each call site: the nine fire-and-forget promises are
guarded, and `jobs/runNode.ts:554-558` explains a throw that once escaped this
way. What is missing is the net under the next one.

**Fix (S).** Handlers that write the error and stack to the log. Keep serving
for `unhandledRejection` (Bonsai's work is per request and per run, and staying
up keeps other runs alive); for `uncaughtException`, log, close the database and
exit, since state may be broken.

### S3 · Medium · by reading — An open tab keeps running old code after an upgrade

The page never learns the server changed. The event stream's first message is
`{ type: 'hello', projectId }` (`api/events.ts:32`), with no version, and the
page reconnects to a restarted server silently. After `git pull` and
`npm start`, a tab left open keeps its old interface code against the new API,
and `npm start --open` opens a new tab beside it. Mostly this still works;
when a request or response shape has changed it fails in ways that look like
bugs in the new version.

**Fix (S).** Send a build id (a hash of `ui/dist/index.html` is enough) in
`hello`; when it differs from the one the page loaded with, show "Bonsai was
updated — reload" rather than carrying on.

### S4 · Medium · verified — The HTTP layer is tested only through the browser

No unit test loads a route handler (phase 0). Every route's validation, status
codes and error paths are covered only by the browser suite — 77 s, the slowest
and the only intermittent suite — or not at all. Findings like S1 and S3 live
exactly here.

**Fix (M).** An in-process test helper that starts the server on port 0 with an
in-memory store and the stand-in runner, so a route test is a `fetch` and an
assertion. Start with the routes that change or delete things.

## What is solid

- **The local-only boundary.** Loopback bind, plus Host, Origin and body-type
  checks independent of CORS. A web page you visit cannot drive Bonsai, which
  matters for a server with no login that runs an agent on your code.
- **Settings.** Written atomically (temporary file, then rename), 0600, and the
  API key never leaves the server — the page is told only whether one exists.
- **Logging.** One JSON line per event, a file per day, fourteen kept, and a
  written rule never to record prompts, file contents, diffs or keys.
- **Shutdown.** Cancels runs, gives them 3 s, closes the database; a second
  Ctrl-C exits at once.
- **Startup cost does not grow with the tree** — 0.3 s with 500 experiments.

## Handed to later phases

- On Windows, the connection check runs `claude` without a shell; an npm-installed
  CLI is `claude.cmd`, which Node cannot start that way, so it would likely
  report "not installed". Unverified here. → phase 14.
- A crash between Bonsai's git commit and recording it in the database leaves
  the two disagreeing, and the next run reports the Git state "changed outside
  Bonsai". → phase 5, chaos tests.

## Fix first

S1, then S2. Both are small, and S1 is the only one here a normal day can
trigger.
