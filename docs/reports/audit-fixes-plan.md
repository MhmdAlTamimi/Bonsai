# Audit fixes implementation checklist

Branch: `codex/audit-fixes`, based on `claude/audit` at `d7f9c87`.

Keep the modular monolith. Do not call a real model API: use the stand-in runner or the real SDK only with `ANTHROPIC_BASE_URL` pointing at `scripts/audit/fake-api.mjs`. No new dependencies without approval.

## Accepted product decisions

- Recovery must explain Git/Bonsai differences, preserve work, and provide explicit safe synchronization. No silent reset of unknown work.
- Manual archiving shows a clear text warning about ignored files. Further automatic-archiving changes are deferred.
- Dollar budgets and daily/project spending caps are deferred for subscription use. Correctness of displayed API-equivalent usage is still in scope.
- Phases 15–17 have not been audited; this branch does not claim to complete them.

## Order of work

1. Startup exclusivity, migration backups, database indexes, Git integrity.
2. Git integration, safe files/patches, adoption guards, manual archive warning.
3. Durable requests/drafts/attachments and failed-tool evidence.
4. Safe explicit recovery, atomic database finalization and bounded job lifecycle.
5. Connection/session fallback, complete independent export, storage visibility.
6. Multi-tab transport, attention/questions, scoped updates and bounded rendering.
7. Remaining audited usability/platform fixes and final verification.

## Findings

A checkbox is checked only after implementation and relevant verification. Deferred items are labeled and stay unchecked. Validation notes and commit references follow below.

### audit-01-server-shell

- [x] S1: Two copies of Bonsai on one data folder corrupt each other's runs
- [x] S2: One unexpected error stops everything, and leaves no trace in the log
- [ ] S3: An open tab keeps running old code after an upgrade
- [x] S4: The HTTP layer is tested only through the browser

### audit-02-database

- [x] D1: The pre-upgrade backup can be empty
- [x] D2: Deleting freezes the whole app, for longer the more you have used it
- [x] D3: A run's end is recorded in several separate writes

### audit-03-starting-a-project

- [x] P1: Starting from a folder that is not in git commits everything in it, dependencies and secrets included
- [x] P2: Your home folder, or the whole disk, can be chosen, with no warning
- [x] P3: A project whose folder is moved or renamed stops working, and says its code is gone
- [x] P4: Commit signing in your git config breaks every run
- [x] P5: Names in Arabic, Japanese or with accents become "project", "project-2"
- [x] P6: "Include my unsaved changes" re-reads the whole repository

### audit-04-experiments-and-their-code

- [x] G1: Your git hooks run on Bonsai's commits, and a failing one stops every run
- [x] G2: With `diff.noprefix` in your git config, Apply writes files to the wrong place and says it worked
- [x] G3: Bonsai ignores the git settings Windows keeps for you, and honours the ones that break it
- [x] G4: Submodules are empty in every experiment
- [x] G5: Bonsai's run notes collide with a `CONTEXT.md` of your own

### audit-05-removing-and-recovering

- [x] R1: A crash while a run is saving leaves the experiment stuck for good
- [x] R2: A delete that stops part-way leaves experiments on the map with nothing behind them
- [x] R3: `git fsck` reports every project Bonsai created as broken

### audit-06-backups-export-moving

- [x] B1: Moving the data folder breaks every project, and says your code is gone
- [ ] B2: A backup taken while Bonsai runs gives back broken experiments, and Bonsai offers no safe one
- [x] B3: Putting back an older database leaves stuck experiments and leftovers nobody can see
- [ ] B4: An experiment's conversation lives in Claude Code's folder, where it is not backed up, not moved, and deleted after 30 days
- [x] B5: A missing folder is reported as an empty git error

### audit-07-a-run-start-to-finish

- [ ] A1: Each run's cost includes every earlier run of its experiment, so Usage is overstated, and more so the more you use it
- [x] A2: While Claude Code retries a failing API, Bonsai just shows "working"; a rejected key takes three minutes to fail, and one rate limit stops every experiment until you re-check
- [x] A3: A request waiting in the queue is lost when Bonsai closes, and after a crash Resume sends the previous request instead
- [ ] A4: No spending limit, and a run's cost is unknown until it ends — budget limits deferred; missing/incorrect accounting remains in scope

### audit-08-inside-a-run

- [x] I1: A tool that commits by itself leaves the experiment stuck, and its tag lands in your repository
- [x] I2: A command that fails shows no output in the conversation
- [x] I3: Runs waiting on you, or on background work, hold run slots; a new request queues with no reason given — retain the bound on live processes and explain blockers
- [ ] I4: On Windows, processes the agent leaves running are neither found nor stopped

### audit-09-live-updates

- [ ] L1: Six tabs freeze Bonsai in every tab
- [ ] L2: Every change anywhere in the project downloads the open conversation again, in full

### audit-10-the-map

- [ ] M1: Nothing tells you an experiment is waiting for you
- [ ] M2: The map opens too far out to read, and there is no way to find an experiment by name
- [ ] M3: Every update re-lays out and redraws the whole map
- [ ] M4: With a keyboard, the map is a long flat list
- [ ] M5: For a project Bonsai created, the top bar spends its width on Bonsai's storage path

### audit-11-conversation-panel

- [x] C1: An unsent message is lost when the page reloads
- [ ] C2: A long conversation slows the whole page, whatever else is happening
- [ ] C3: When the agent asks you something, the answer buttons are below the fold
- [x] C4: A queued request is not shown in its own panel
- [ ] C5: Result tables break their words apart at the panel's default width

### audit-12-review-and-apply

- [x] V1: For a project Bonsai created, there is no safe way to take an experiment's code out
- [x] V2: Review is twenty times slower when the experiment has uncommitted work
- [x] V3: What Apply's command prints is hard to read, on success and on failure

### audit-13-sharing-between-experiments

- [ ] X1: Every comparison keeps a full copy of each compared experiment's repository, and nothing counts or removes them
- [ ] X2: Spending on comparisons and on drafted references is not in Usage
- [ ] X3: A comparison's address does not open it
- [x] X4: *Start from latest*, saved for later, loses the work it carries

### audit-14-sign-in-and-settings

- [x] N1: A wrong or revoked API key is reported as a timeout, "or offline"
- [x] N2: Signing in with a subscription needs a second, separately installed Claude Code
- [ ] N3: Edits in Settings are dropped without a word when it closes

## Additional issues from validation

- [ ] E1: Modified copy-in ignored files can be lost on archive. Manual warning in scope; automatic preservation/blocking deferred.
- [x] E2: Apply artifacts collide and can change after their command is displayed.
- [x] E3: Project deletion and concurrency bounds omit comparison/draft jobs.
- [ ] E4: Deleting experiments changes historical spending totals.
- [x] E5: HTTP drain precedes the shutdown cancellation deadline.

- [x] E6: A failed submodule setup must remove the newly created checkout so retry does not hit an unexpected-folder dead end.

- [x] E7: Questions from ended or restarted runs must not remain pending or show stale answer controls.
- [x] E8: Deletion must not race an idle archive, export or synchronization operation.
- [x] E9: Recovery must preserve staged-only content and all unresolved merge-index versions; do not import unresolved conflict markers as finished work.
- [x] E10: Committed per-run diffs must remain readable without the experiment checkout.
- [x] E11: Ignored run-note paths must not cause fallback text to overwrite agent notes or lose their committed history. Resume must name the project’s recorded notes path.
- [x] E12: Independent recovery copies must survive deletion of their original project.
- [x] E13: An unexpected folder at an unallocated experiment path must never be silently deleted.
- [x] E14: The second force needed for submodule cleanup must respect Git worktree locks.
- [x] E15: Removing one missing checkout must not globally prune unrelated missing worktrees.
- [x] E16: Deleting a project restored from an older database must preserve experiments omitted from that database until explicitly recovered.
- [x] E17: Subscription mode must not silently inherit an API key from the environment; an empty selected API key must not fall back to subscription credentials.
- [x] E18: An SDK result with `subtype: success` and `is_error: true` must not finish a run or commit partial work as successful.
- [x] E19: Git/setup/task errors that mention authentication must not invalidate the Claude connection.
- [x] E20: Deleting a comparison removes its files and rows before its active answer has unwound.

## Verification log

- Baseline review: build, 367 server tests, 120 UI/shared tests and 25 browser tests passed; documented independent validation is in `/workspace/bonsai-review/REVIEW.md`.

- Foundation fixes (`a65ba2c`): full `npm test` passed (369 server tests, 120 UI/shared tests) and `npm run build:ui` passed; an additional real-Git integrity test and crash-released instance-lock test passed. WAL-crash reproduction now backs up all 50 experiments. Two-instance reproduction refuses both duplicate servers while the original run completes normally. Deletion benchmark explicitly drops the index for the baseline: whole-project deletion fell from 14.6 s to 0.63 s for 180,000 messages. Fatal errors are logged and shut down; continued serving after an uncaught error is deliberately avoided.

- Git/files batch (`ed33ce5`): 377 server tests, 120 UI/shared tests and all 25 browser tests passed; production build passed. Real Git tests cover hook/signing isolation, system config, stable diff prefixes, unique immutable Apply artifacts, submodule contents and failed-setup cleanup. Adoption reproduction excludes 20,000 dependency files and the credential canary without writing `.git` in the source; home/root are refused. The 40,000-file Review reproduction now opens dirty files in 279–302 ms (previously 4.3–5.2 s). New projects use their own recorded `.bonsai/notes-<project>.md`; old projects retain `CONTEXT.md` compatibility. Manual archive text is browser-tested; automatic ignored-file handling remains deferred. Audit SDK helper now verifies the fake API identity before starting, with bounded readiness/settle waits.

- Durable-input batch: full `npm test` passed (381 server tests, 120 UI/shared tests), production build and all 26 browser tests passed. Database reopen tests preserve queued prompts and attachment identities; an injected final-status write failure rolls back the commit, totals and conversation position together. Both SIGTERM and SIGKILL reproductions resume the waiting request. SDK-frame tests retain failed-command text with bounded output. Browser reload tests cover unsent per-tab drafts and a saved Start-from-latest attachment after browser storage is cleared. Real HTTP tests cover validation, origin restrictions, SSE and run acceptance/finalization.

- Git recovery/export batch: full `npm test` passed (391 server tests, 120 UI/shared tests), production build and all 27 browser tests passed. Fault injection followed by database reopen covers saves before Git moves, after Git moves, and the legacy HEAD/ref split; unrelated commits are refused. Real Git tests preserve ignored files, staged-only content, every merge-conflict index stage, branch tips and history, reject stale choices, restore missing folders and prove exported repositories survive deletion of the source storage. HTTP regressions keep recovery and committed run diffs reachable without a checkout. Twenty seeded SIGKILL rounds produced no stuck experiments, mismatched refs or integrity errors. Real SDK `npm version` reproduction used the verified fake API: no source tag/commit appeared and the next run succeeded. Known implicit version commits are guarded; arbitrary shell commands remain cooperative, not a security sandbox. Older-database Git drift now has explicit import/restore; orphan discovery remains to finish B3.

- Durable deletion batch: production build, typecheck/lint/format, all 397 server tests, 120 UI/shared tests and 28 browser tests passed. Real Git lock failures and a database trigger interrupt cleanup after filesystem removal; restart finishes only matching cleanup and refuses a changed ref. Browser recovery cancels remaining cleanup and explicitly restores the missing checkout. Ten SIGKILL rounds now wait for actual folder removal before killing: all ten deletions finish on restart, with zero half-deleted experiments. Recovery repositories survive project deletion; an unallocated unexpected checkout and a locked worktree are preserved. The Start-from-latest browser fixture now waits for preview readiness before clicking its disabled button.

- Storage relocation/discovery batch: production build, typecheck/lint/format, all 404 server tests, 120 UI/shared tests and 29 browser tests passed. Tests move and copy managed storage, retain dirty/ignored/index content, restore archived checkouts, refuse an unrelated source repository and resume a durable path move after an injected database failure. The moved-data audit script now asserts successful continuation and uses the explicit Locate repository workflow for the moved external source. Browser coverage exercises that fallback and recovery of missing experiment metadata through Project settings. Git saves from an older database remain explicit import/restore choices; unrecorded experiments are discoverable and recoverable with independent copies. Copying data that shares an external repository while its original checkouts still exist is deliberately refused to avoid displacing the original instance. Stored managed location preferences move with data; external preferences stay explicit.
  Follow-up: all 13 relocation/discovery/deletion regressions pass with a guard against project deletion while unrecorded Git experiments exist. This avoids deleting work that an older database cannot include in its deletion preview.

- Connection/retry batch: production build, typecheck/lint/format, all 413 server tests, 120 UI/shared tests and 30 browser tests passed. Scripted SDK frames verify visible retries, bounded retry count and deadline, immediate terminal classification and `is_error` results. Real SDK reproductions used the verified fake API: credential/account failures finish in seconds, all partial files remain recoverable without a finished commit, and rate/overload failures leave the gate usable. Real connection probes classify 401, billing and 429 in 6.6–7.8 seconds instead of the previous timeout. Browser coverage keeps Stop available during retries. Subscription authentication resolves the installed SDK executable without global CLI discovery; actual account sign-in requires the user's credential. Environment canaries verify auth-mode precedence and preservation of the fake API URL. A real job-pipeline regression proves ordinary failures cannot change the Claude gate.

- Shared scheduler batch: production build, typecheck/lint/format, all 417 server tests, 120 UI/shared tests and 30 browser tests passed. Real HTTP/Git/SQLite tests interleave runs, comparisons and drafts at a limit of one, verify FIFO ordering and a peak of one process, and cancel queued work during project deletion. Delayed comparison cleanup writes successfully before either project or comparison deletion removes its rows/files. An idle maintenance gate refuses API/filesystem mutations and releases after an injected failure. Browser coverage verifies a queued experiment explains that another job needs an answer. Question/background jobs intentionally retain slots while their processes remain live; Stop or answering the question is the explicit way to free capacity. Shutdown drains the same shared pool.
