# Stabilization phases A–D

Implemented on `codex/stabilize-a-d`, based on main `015b0aed406a927d09ef9f4a80a447bff6a64645`.
This is the stabilization milestone, not the later feature phases.

## Delivered

| Phase | Changes |
| --- | --- |
| A — baseline and instructions | Reproduced browser failures; replaced PRD-era contributor gates; documented supported Node/browser setup, development rebuilds, permissions and safe settings reset. |
| B — repository safety | Reject detached adoption without moving refs; skip setup on read-only originals; require destination ignore rules and safe copy paths; verify recorded HEAD, branch and common repository around runs/commits and before discard/deletion; retain unexpected work; snapshot eligible untracked files without modifying the real index; correct SDK bypass opt-in and permission labels. |
| C — execution and review | Put setup inside the failure boundary; cancel POSIX command groups with bounded escalation; mark and verify process cleanup; compensate failed project/node allocation; distinguish recovery requests from later answers; compare cumulative committed and dirty snapshots; stream bounded patch collection; use root notes paths for nested projects; retain subagent attribution and label unknown tools neutrally. |
| D — cleanup and gate | Remove unused lifecycle and milestone HTTP scaffolding and the runtime fake-project seed switch; retain the database test fixture and migrations; repair activity subscription, reading-position anchoring and Stop state across rapid reruns; add focused regression coverage and refresh current docs. |

## Verification

Environment: Linux, Node 24.19.0, Chromium 153, installed lockfile dependencies
including Claude Agent SDK 0.3.263. No added dependencies or database migrations.

- Baseline: 246 server tests and 95 UI/shared tests passed. The browser baseline had
  six failures locally, including an empty-home-folder fixture assumption and activity
  display/completion failures. The previously reviewed CI also failed browser scenarios.
- Final `npm test`: **271 server tests and 95 UI/shared tests passed**; server build,
  typecheck, lint and formatting passed.
- Final `npm run test:e2e`: **16 browser scenarios passed, none skipped**, including the
  new regression for a second Stop when the browser missed the intervening idle state.
  This command also built the production UI successfully.
- Additional temporary-project browser/API smoke: adopted original checkout unchanged;
  nested working directory setup and code edits; notes at repository root; review;
  Stop with detached work; Keep/Resume; Discard; created-project no-change conversation;
  switching between projects.
- Production bundling still reports the existing large-chunk advisory. It is not a
  build failure; code splitting is not part of this stabilization change.

The detached-process browser failure was an actual missing `run.activity` event
subscription. After adding it, the UI receives waiting/working changes. Browser teardown
now cancels residual runs so a failed scenario cannot contaminate later queue tests.
Reading-position ownership disables native scroll anchoring in the conversation region.

## Preserved behavior and remaining decisions

- Worktrees are **not host sandboxes**. Integrity checks and the command hook cannot
  contain arbitrary code. External scoped approval remains a later implementation;
  prompts currently direct the agent to give the user instructions for external changes.
- SDK configuration is covered by adapter tests. Authenticated/live model probes were
  not run, and this milestone does not claim new runtime containment guarantees.
- SDK plan mode is not an app-enforced read-only mode: its ordinary permission callback
  still approves requests reaching it, and setup can run. The UI and README now say so.
  Read-only experiment ownership separately forces restricted tools and skips setup.
- Freeze authority is captured when a run is submitted, including queued runs. A child
  committing before its queued parent dispatches does not recalculate that authority.
  This remains explicit for the parent-revision/queue design checkpoint; no silent
  submission-versus-dispatch semantics change is included here.
- Setup remains once-per-node, including command failures; cancellation is not marked
  completed. Versioned setup, explicit retry and a richer setup lifecycle remain later work.
- Recovery uses the first user message of the latest attributed run. Legacy messages
  without run IDs cannot safely distinguish requests from answers, so recovery falls
  back to the node description. This does not rewrite stored messages.
- Process cleanup is bounded and reported, but cannot guarantee cleanup of unmarked
  processes or abrupt host crashes. Windows detached-process discovery is unsupported.
- Git drift is preserved and reported, not automatically reconciled. If compensating
  cleanup cannot safely finish, the operation retains its row with an identifying error.
  Resolving externally changed state is still a manual Git operation.
- Aggregate review snapshots use a temporary index and Git objects without changing
  the real index or refs. Very large workspaces may still incur Git scanning/hashing
  cost; bounded patch buffering does not make all repository work constant-time.
- Parent freezing, conversation inheritance timing, special `CONTEXT.md` behavior,
  Finish now semantics and eager worktree allocation remain pending their agreed design
  discussions. References, uploads, multiple parents, Apply, SDK feature expansion,
  dashboards and archive redesign are not introduced by A–D.
