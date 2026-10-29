# Development

## Setup

Install Node.js 22.18+, npm, and Git, then run `npm ci` from the repository root.

Use separate terminals:

```bash
npm run dev
npm run dev:ui
```

The backend runs at `http://localhost:8787`; Vite serves the UI at `http://localhost:5173`
and proxies API requests to the backend. Restart `npm run dev` after server changes.
It builds the server once; it is not a server watcher.

`npm start` builds and serves both halves. `npm run build:ui` refreshes the production UI
served by the backend; Vite edits do not update that bundle automatically.

## Verification

```bash
npm test
npm run build:ui
npm run test:e2e
```

`npm test` builds the server and runs typechecking, lint, formatting, server tests, and
UI/shared tests. Browser tests require Chrome/Chromium; set `BONSAI_CHROME` if needed.
GitHub Actions runs the checks on Linux and Windows.

Use temporary repositories and fake runners. Never use real user projects as fixtures.
Do not invoke the real agent for routine tests: inherited credentials may be present.
When intentionally running an audit probe through the real SDK, first point
`ANTHROPIC_BASE_URL` at the verified local `scripts/audit/fake-api.mjs` server.

The Windows CI fixture environment disables global CRLF conversion for deterministic
LF fixtures. Repository-local CRLF handling is tested separately; production Git invocations
retain the user's filters and line-ending configuration.

## Validation status

Consolidation candidate: [`5527ab9`](https://github.com/MhmdAlTamimi/Bonsai/commit/5527ab9e2880818a53a6eff22c4091dad2070d7c).
[CI evidence](https://github.com/MhmdAlTamimi/Bonsai/actions/runs/40884112890), 29 October 2026:

| Check | Result |
| --- | --- |
| Linux server tests | 474 passed. |
| Linux UI/shared tests | 123 passed. |
| Linux browser tests | 42 passed. |
| Windows server tests | 467 passed, 7 platform-specific skips. |
| Windows UI/shared tests | 123 passed. |
| Windows type/lint/format/build | Passed. |
| Windows browser tests | 36 passed, 4 failed, 2 platform-specific skips. |

The Windows browser failures below remain open and were deferred during consolidation.
Do not treat this candidate as fully validated on Windows or disable these CI checks.

1. **Source disclosure:** the renamed ancestor was not observed in the child-creation source popover.
2. **Review readiness:** the experiment did not reach the expected ready state within the browser test's deadline.
3. **Cancellation messaging:** the expected stop reason was replaced by a generic unfinished-run message.
4. **Creation dialog:** the run-options summary was not clickable in the narrow-layout scenario.

Investigate these against the Windows screenshots and logs; the results do not yet
establish whether each failure is application behavior, browser automation, or timing.
Retain the assertions while fixing the causes.

## Configuration

| Variable | Purpose |
| --- | --- |
| `BONSAI_PORT` | Backend port; default `8787`. Vite's default proxy targets 8787. |
| `BONSAI_DATA_DIR` | Database and settings directory; defaults to OS app data. |
| `BONSAI_REPOS_ROOT` | Default managed repository storage; defaults to `<data dir>/repos`. |
| `BONSAI_MODEL` | Optional default model. |
| `BONSAI_FAKE_AGENT=1` | Explicit stand-in runner for local development. Output is fake. |
| `BONSAI_CHROME` | Chrome/Chromium path for browser tests. |

Use new data and repository directories when testing another version.
Settings can override the default repository location; existing projects keep their
recorded paths. Git branches do not isolate application data.
Never downgrade a database's schema number to make an older build open it.

## Code layout

| Path | Responsibility |
| --- | --- |
| `packages/shared` | API and data contracts. |
| `packages/server/src/api` | HTTP routes, validation, events, and diagnostics. |
| `packages/server/src/db` | SQLite stores, schema, and migrations. |
| `packages/server/src/domain` | Lineage, flags, and conflicts. |
| `packages/server/src/git` | Git execution, refs, commits, review, and exports. |
| `packages/server/src/jobs` | Scheduling, workspace activation, setup, and sessions. |
| `packages/server/src/storage` | Backup, relocation, conversion, and recovery. |
| `packages/ui/src` | React canvas, conversations, review, and settings. |
| `scripts/audit` | Historical reproduction probes and fake API. |

Read [architecture](architecture.md) and [AGENTS.md](../AGENTS.md) before changing behavior.
Historical plans and the previous architecture are in the [archive](archive/README.md);
they are not current product requirements.

## Contribution boundaries

Keep filesystem, Git, and scheduling decisions in the server. The UI sends intents through
the API. Use shared path helpers for ownership checks and real-Git tests for changes that
can affect saved work. Preserve explicit recovery and existing-project conversion support.

Add dependencies only with approval. Keep changes focused and run the checks relevant to
the change. See [architecture](architecture.md#safety-boundaries) for execution limitations.
