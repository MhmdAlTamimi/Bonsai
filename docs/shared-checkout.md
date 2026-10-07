# Shared checkout implementation

Branch: `codex/shared-checkout`. The app remains a modular monolith. Workspace coordination,
Git safety and filesystem transitions stay in the server; the UI sends intents.

## Workflow

Each project has one managed checkout. Experiments retain independent pinned bases, saved
tips, hidden refs, conversations, sessions, notes and run history. Activating code changes
workspace ownership, never lineage. Adopted repositories keep their original checkout and
branches untouched. The managed checkout is detached; no visible experiment branches are
required.

Same-project runs queue, including read-only runs and compaction that use the checkout.
Questions, retries, setup, saving and owned background cleanup retain it. Other projects
and independent snapshot comparisons/reference drafts can proceed subject to the global
execution limit. Waiting for a workspace does not consume that limit.

Browsing conversations, Review, Apply and Compare reads saved experiments without switching.
Running activates the selected experiment. Open folder activates and sets **Keep active**;
release the checkbox after stopping external previews before switching. Dirty work blocks
switches and uses the existing explicit resume/import/discard workflow.

Only explicitly declared ignored **Regeneratable folders** are disposable. Other ignored
files move into private per-experiment storage and return on activation. Settings accept
literal repository-relative paths, not globs. Copy-in changes remain experiment-specific;
fresh experiments use the copy-in baseline. Setup reruns on switches/configuration changes,
not every message on the same active experiment. Read-only runs skip setup.

## Implementation checklist

- [x] Phase 0: inventory allocation, scheduler, saved state, recovery, read paths and cleanup;
  measure a reproducible six-experiment synthetic baseline.
- [x] Phase 1: add project workspace ownership, generation, hold, cleanup policy and durable
  switch stages; expose saved versus active experiments without treating each as a checkout.
- [x] Phase 2: reserve project resources in the existing execution pool and hold an OS-backed
  SQLite lock throughout checkout-using operations. Serialize project runs while retaining
  concurrency across projects and independent snapshots.
- [x] Phase 3: verify source/target refs, ownership, Git state, dirty files, locks, submodules
  and pending saves before switching; preserve unknown files before removal; replay only
  matching durable stages. Unexpected state stays blocked with explicit recovery actions.
- [x] Phase 4: use an explicit regeneratable-artifact policy and conservative setup reruns.
  Test A/B/A environments; avoid assuming matching lockfiles prove arbitrary setup equivalent.
- [x] Phase 5: bind durable saves to workspace generation, refresh allocated paths, retain
  UUID-based session ownership and child cuts, and include current node/cwd in agent context.
- [x] Phase 6: read inactive notes/reviews/diffs from exact commits. Validate generations for
  live reads; folder opening explicitly activates. Apply/Compare remain snapshot operations.
- [x] Phase 7: free the project workspace without deleting saved experiments; protect held,
  busy, dirty and drifted state; preserve node outputs; adapt deletion, orphan import,
  relocation, backup/restore and storage accounting.
- [x] Phase 8: default new projects to shared mode; convert existing projects explicitly
  through Project settings, using immutable preflight/journals and verified preservation.
  Resume interruptions. Schema 29 prevents older builds opening upgraded storage.
- [x] Phase 9: real-Git shared regressions, compatibility regressions, browser workflows,
  typechecking, lint, formatting, UI build and synthetic storage measurement.

## Recovery and conversion

In Project settings, **Review conversion** checks the old folders and shows blockers and
counts before **Convert workspace**. Unknown ignored data is moved safely rather than
duplicated wholesale. Across filesystems, copies are verified before originals are removed.
Old folders are removed through Git after saved tips and local data are protected. A failed
conversion retains its journal and offers **Resume conversion**; its setup/cleanup policy
cannot change halfway through.

For interrupted switching, **Retry preparation** replays verified stages. **Preserve files
and restore** verifies independent exports and literal working-file copies, including staged
content, unexpected commits, ignored files and retained local stores, before replacing the
owned checkout. Raw working-file copies are forensic snapshots, not registered checkouts;
the accompanying exported repository has independent Git history. Unexpected repository
identity, locks, changes after preservation, or later index changes block replacement.
Recovery interruptions at preservation, checkout, restore and finalization are tested.

Backups and relocation refuse unresolved preparation/conversion/recovery. Recovery copies
remain outside project deletion. Conversion has no automatic rollback: make a backup before
converting an important project, and use a separate pre-upgrade backup with an older build.

## Evidence and limits

Local verification: `npm test` passed 472 server tests and 123 UI/shared tests, including
29 shared-workspace regressions. `npm run test:e2e` passed all 42 browser tests and built
the UI. Typechecking, lint and formatting checks passed on Linux with Node 24.19.

`packages/server/src/jobs/projectWorkspace.test.ts` covers six independent experiments,
pinned bases, ignored/copy-in data, clean switching, submodules, dirty/staged/untracked work,
holds, lock contention, drift, missing folders, interrupted switching/conversion/recovery,
generation-bound saves, inactive reads, deletion, orphan recovery, setup reruns/session continuity,
other-project concurrency and independent backup restoration.

Browser checks exercise production shared-mode creation/runs, queued questions/cancellation,
saved reviews/Apply/Compare, external-use holds, cleanup, drift, deletion recovery, relocation
and explicit conversion in Project settings. Legacy fixture helpers retain coverage of
unconverted projects; shared tests use the production defaults. All agent execution uses
test runners, without real credentials.

The synthetic fixture has six experiments plus the root checkout: 1 MiB of tracked source,
4 MiB of disposable environment per experiment, and 128 KiB of valuable output per
experiment. It measures roughly 31.8 MiB of working files before conversion versus 5.1 MiB
of one current workspace plus 0.65 MiB of retained outputs afterwards: about 82% less for
those categories. Rebuilding one environment is included. Conversion took approximately
0.5–1 second locally, varying with concurrent test activity. Git history, database, exports,
recovery, backups and external package caches are separate; this is not a measurement of
the user's 7 GB project, a realistic package install, or application startup latency.

Git storage is counted once per common repository; working folders, copy-in baselines,
retained local files, comparisons, reference attachments, database and recovery/export/backup
folders are distinguished. Figures estimate file allocation or file size where allocation
is unavailable, without deduplicating hardlink inodes or reflink extents. Adopted repository
history may already exist outside Bonsai's incremental disk usage.

Deliberate limits:

- Unknown dependency folders are preserved until declared regeneratable, so savings depend
  on project configuration. Retained outputs and safety copies can still be large.
- Verified installed-environment reuse is deferred. Setup reruns trade switching latency
  for correctness and disk savings; no package-manager-specific cache service is introduced.
- Conservative submodule switching blocks local or ignored submodule changes. Preserve or
  clean those explicitly before switching; arbitrary submodule environments are not shared.
- Linux checks run locally. Windows path/process checks are in the existing CI matrix and
  must pass remotely before merging; local Linux results do not establish Windows results.
- No microservices, workspace pool, silent stashes, daily/project budgets, or automatic
  conversion of user projects are introduced.
