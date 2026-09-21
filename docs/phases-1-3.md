# Phases 1–3 implementation

Base: `codex/stabilize-a-d` at `7d25e8c`. Planning source: `f8ecfe7`.
Implementation branch: `codex/phases-1-3`. No changes from the old milestone checkout were carried over.

## Approved clarifications

- Phase 1 may add a bounded changed-file content endpoint and persisted wrapping preference.
  The existing review endpoint had patches only, so the brief's UI-only assumption was incorrect.
- Parent context refresh is automatic. Bonsai prepares the latest parent conversation for every
  run; the agent reads it on demand. No user attach/refresh action is required. Child history stays intact.
- Fix blockers in the affected flows, with regression coverage for work-preservation behavior.

## Reading and reopening

Review already covered aggregate experiment changes and uncommitted work. The implementation extends
that screen with File/Diff switching, persistent wrapping and direct folder opening. File reads are
limited to changed paths, use Git blobs rather than following filesystem symlinks, and stop at 2 MiB.
Deleted files show their prior contents; binary files remain explicitly unavailable as text.

Project switching now exposes every project and displays repository/working-folder identity. Folder
inspection permits multiple projects on an adopted original repository and offers reopening first.
Bonsai-managed worktrees still point to the existing owner. Real-Git tests cover deletion with shared
repositories and the separation of generated storage for created projects.

## Creation and per-run context

An experiment can be created with only a name, including while the agent is unavailable. Creation
pins its code revision but allocates no checkout and starts no setup or agent job. The first run
allocates the detached worktree. Allocation failures preserve the experiment for retry and never
replace an unexpected existing folder. Database migration 15 marks existing checkouts as allocated
so a missing established checkout is not silently recreated.

Before each run, Bonsai captures a fixed snapshot of the direct parent's current conversation,
along with the run's goal, verification instructions and starting code revision. The app supplies
the snapshot path to the agent automatically; reading it does not require a user action. The agent
can read it when relevant, while retaining the child's own session. Existing sessions are preserved.
Run context shows the available parent message boundary and fingerprint; actual reads appear in
the tool transcript. Availability alone does not assert that the agent consulted the snapshot.

A committed child no longer freezes its parent. Adopted original checkouts remain read-only.
Children retain their pinned code and show when the parent's code has moved ahead. Updating from
the parent, Apply, references and notes migration remain outside these phases.

Snapshots currently store full transcripts per run; automatic compaction and deduplication are
not implemented. They live outside experiment checkouts and are removed with their owning node or
project. These files and worktrees are not security sandboxes.

## Validation and review

- `npm test`: 270 server tests and 95 UI/shared tests passed, including type, lint and formatting checks.
- `npm run test:e2e`: all 18 browser scenarios passed; this also builds the server and UI.
- Real Git tests cover pinned revisions, shared repository deletion, lazy allocation, drift and
  preservation after failures. Context tests cover repeated runs and parent changes during a run.
- Agent behavior was checked with the fake runner and existing SDK adapter tests, without a live
  paid-provider run. Validation used Node 25.2.1; CI uses Node 22.x.

Restart the backend after switching to this branch, then review:

1. Open Review, switch File/Diff, enable wrapping, change experiments and reopen the app. Check a
   deleted file and open an allocated experiment's folder.
2. Select an already adopted repository in the folder picker. Reopen an existing project, then use
   the secondary option to create another. Switch between them and check the repository/folder labels.
3. Create an experiment using only its name. Add its goal/checks in Details and send its first request.
4. Continue the parent after a child commits. Run the child again, inspect Run context and confirm
   the latest parent conversation is available while the child's code remains pinned.

The implementation is kept on `codex/phases-1-3` for review before merge or push.
