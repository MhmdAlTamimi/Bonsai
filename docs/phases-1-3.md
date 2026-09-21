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
