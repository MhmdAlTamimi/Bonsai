# Audit phase 15 — local security and private data

2026-10-04, `codex/audit-fixes`. This phase reviews the corrected application, not an unchanged copy of `main` at 5842b8c. No real credentials or external model endpoints were used.

## Findings and fixes

### P1 · Medium · reproduced — another localhost website could send mutations

`assertLocalRequest` originally accepted any loopback Origin, irrespective of port. A page served by another local application could issue a simple, bodyless POST to Bonsai. CORS restricting response reads does not prevent the request from executing. Foreign website origins and DNS-rebinding Host values were already refused; this is not evidence of arbitrary remote access.

Require an exact origin, including scheme and port. Development explicitly allows the two Vite origins on port 5173 only when the server runs with `--dev`; `npm run dev` supplies that flag. Vite uses a fixed port so this exception stays narrow. Native local clients without Origin remain supported. The real HTTP regression checks rejection before routing, and guard tests check ordinary access and the explicit development exception.

### P2 · Medium on shared machines · reproduced — private files inherited permissive defaults

With umask 022, a newly created data directory was 0755 and its database was 0644. Conversations, SDK transcripts and error logs can contain private information. The default umask of this review workspace was stricter, so the reproduction explicitly sets 022.

New app data/log/backup directories now request 0700. The database, migration backup and new log files request 0600; opening/writing the database/log also restricts the existing file; opening repairs existing WAL/SHM permissions and the logger restricts its owned directory and older log files. Tests use an actual database and file logger under umask 022. These POSIX modes do not establish Windows ACLs. Arbitrary existing user-selected parent directories are not recursively chmodded; repository access and operating-system account isolation remain relevant.

### P3 · Medium · reproduced — raw failure logs retained credential-shaped text

A fake API-key canary inside an error message was retained by `FileLogger`. Diagnostics exports already omit free-form errors, but the raw log did not honor the same confidentiality expectations.

A shared recursive redactor now covers the logger and diagnostics metadata, including common token formats, Bearer values and credential-named fields. Ordinary error context and metrics remain useful. Tests verify the actual written file. Pattern redaction is defense in depth, not permission to log arbitrary prompts, output or unknown secret formats; callers must continue to omit those fields.

## Boundaries reviewed

- The HTTP server binds loopback; Host checks reject foreign names. The API validates object-shaped JSON and bounds request bodies.
- Browser Markdown is rendered through React with restricted link schemes, without raw HTML injection.
- Read-only and comparison agents constrain tools and permission callbacks; reference drafting has no tools.
- Writable agents and setup commands have host access. Worktrees and cooperative Git guards are not sandboxes. This review does not introduce or claim host isolation.
- Settings credentials remain private backend files, are omitted from API views/backups, and never enter browser draft storage. Diagnostics keep their stronger omission policy.

The before/after probe changed cross-port acceptance from true to false, directory/database modes from 755/644 to 700/600, and raw-log canary retention from true to false. Durable regression coverage is in `api/localRequest.test.ts`, `api/http.test.ts`, `privacy.test.ts` and the existing diagnostics/tool-permission suites.
