# Bonsai contributor instructions

Bonsai is a local React/Node application for experiments, Claude Agent SDK conversations,
and reviewing file changes. Read the implementation and tests as the source of truth.
`docs/v0-prd.md`, its decision log, and milestone reports are historical design records;
they are not a scope gate for current work. Follow the user's approved scope.

## Development

Use Node 22.18+ (CI uses current 22.x), Git, and `npm ci`. Run `npm test` and
`npm run build:ui`. Browser changes also require `npm run test:e2e` with Chrome/Chromium;
set `BONSAI_CHROME` to its executable if discovery fails. Tests use temporary repositories
and the fake runner, without credentials. Do not use a real user's project as a fixture.
`npm run dev` rebuilds the server once; restart it after backend changes. Run
`npm run dev:ui` separately for Vite. See README for startup and configuration.
Ask before adding dependencies. Keep changes and commits focused and reviewable.

## Current boundaries

- The backend owns project/node state, Git operations, filesystem access and jobs.
  The UI renders the API contract and sends intents; it does not access these directly.
- A child pins its code base at creation. The app snapshots its direct parent's conversation
  automatically before every execution; the agent reads it on demand. Child sessions retain
  their own history. Code and conversation are separate sources and can diverge.
- Name-only children have no worktree. First execution allocates a detached checkout at
  the pinned base; the first modifying run creates `node/<uuid>`.
  The app commits; the agent must not create branches/worktrees or rewrite Git state.
- Children do not freeze parents (approved Phase 3). Existing children never move to newer
  parent code automatically. An adopted original checkout remains read-only.
- Git state checks detect unexpected HEAD/ref/common-repository changes before execution,
  commit and deletion. Preserve drifted work; never silently reset it to match the database.
- Worktrees are separate checkouts, **not security sandboxes**. Writable commands retain
  host access. The Git command hook is a cooperative guard, not arbitrary-code containment.
  Scoped external approval and Apply are future work, not existing guarantees.
- `CONTEXT.md` currently has special commit behavior at the **worktree root**, independently
  of the selected working subdirectory. Keep that path consistent until notes migration
  is explicitly approved. Preserve existing repository documentation.
- Setup is skipped for read-only runs. Copy-in files must be untracked and ignored in the
  destination; reject unsafe paths and failed inspections. Never copy dependencies.
- Runs are asynchronous. Every exit must finalize state and release the execution slot.
  Use bounded process cleanup, preserve partial work and report incomplete cleanup.
- Use real Git regression tests for ownership, commits, snapshots, recovery and deletion.
  Do not add ceremonial lifecycle helpers disconnected from the API/job implementation.

Later phases (references, notes migration, scoped external actions,
Apply and additional SDK capabilities) require their own scoped implementation work.
