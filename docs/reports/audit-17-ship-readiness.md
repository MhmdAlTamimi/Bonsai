# Audit phase 17 — ship readiness and architecture

2026-10-04, `codex/audit-fixes`.

## Architecture decision

Keep the modular monolith. One local server, SQLite database and shared execution pool suit a single-user local application. Splitting these into services would add process coordination, deployment and consistency problems without resolving the reproduced failures.

The useful boundaries are already in-process: routes validate intents; stores own durable state; Git operations enforce ownership and recovery; jobs share one scheduler and cleanup policy; the SDK adapter owns protocol/retries/sessions; React renders the API contract. The fixes reinforce those boundaries through durable save/deletion journals, one usage ledger, scoped events, one browser live transport and bounded initial history. Further extraction should follow demonstrated independent scaling or isolation needs, not file size alone.

## D1 · Medium release maintenance · verified dependency advisories

The initial npm audit reported 15 entries (8 high, 7 moderate), including dependent-package duplicates. The leaf issues were `brace-expansion`, `fast-uri` and `ip-address`. Brace expansion is development tooling; the other two arrive through SDK/MCP dependencies. Bonsai does not expose the affected MCP/Express server paths as its HTTP server, so these counts were not treated as 15 directly exploitable Bonsai bugs.

Updated only compatible locked patch versions: brace-expansion 1.1.21/5.0.12, fast-uri 3.1.8 and ip-address 10.7.3. No dependency was added, and the SDK version was unchanged. A clean install succeeds and the subsequent npm audit reports zero known vulnerabilities. This is a dated dependency check, not a guarantee against future advisories.

## Release gates

- Build, type checking, lint, formatting, real Git/SQLite/server tests, UI/shared tests and Chromium workflows must pass on the final source. Results are recorded in `audit-fixes-plan.md`.
- All agent reproductions must use the stand-in or the verified local fake API. A successful fake-API run does not validate a real subscription account's entitlement.
- I4 remains open: Windows detached-process discovery/cleanup is not implemented. Linux results and skipped Windows tests cannot establish Windows support for this behavior. A Windows-first release needs an ownership-based implementation (prefer a native Job Object) and tests on Windows. The platform decision is pending; this review does not silently remove existing Windows support.
- Dollar caps and additional automatic ignored-file handling remain explicitly deferred product choices. Manual archiving displays the accepted warning text.
- Backups are independent and tested after removing their originals. Users still need to retain a completed backup outside the source disk.

The app is materially more reliable, but “all phases complete” must not conceal the Windows gate or the deliberately deferred choices. This report does not authorize publication or deployment.
