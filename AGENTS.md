# Bonsai contributor instructions

Bonsai is a local React/Node application for experiments, Claude Agent SDK conversations,
and reviewing file changes. Read the implementation and tests as the source of truth.
`docs/v0-prd.md`, its decision log, and milestone reports are historical design records;
they are not a scope gate for current work. Follow the user's approved scope.

## Development

API routes live in `packages/server/src/api/routes/` by area and register on import; the
first match wins, so keep specific patterns before general ones. Styles live in
`packages/ui/src/styles/`, one file per area, imported in cascade order by `index.css`;
window-size overrides stay last in `responsive.css`.

Use Node 22.18+ (CI uses current 22.x, on Linux and Windows), Git, and `npm ci`. Compare
folders with `isInside`/`samePath`/`canonicalPath` (`paths.ts`), never as text: Windows
spells one folder several ways. Run `npm test` and `npm run build:ui`. Browser changes
also require `npm run test:e2e` with Chrome/Chromium; set `BONSAI_CHROME` to its
executable if discovery fails. Tests use temporary repositories and the fake runner,
without credentials. Do not use a real user's project as a fixture.
`npm run dev` rebuilds the server once; restart it after backend changes. Run
`npm run dev:ui` separately for Vite. See README for startup and configuration.
Ask before adding dependencies. Keep changes and commits focused and reviewable.

## Current boundaries

- The backend owns project/node state, Git operations, filesystem access and jobs.
  The UI renders the API contract and sends intents; it does not access these directly.
- A child pins its code base at creation and, unless created with Start fresh, copies its
  parent's conversation at the same moment (SDK session fork, cut at the parent's last
  finished run). Afterwards a child resumes only its own session; later parent turns never
  flow in. Code and conversation can come from different ancestors when the parent has no
  commits. Compaction (`/compact`) is a read-only run that commits nothing; it resets where a
  later child's copy is cut, so children copy the compacted conversation.
- References are project-scoped text rows: not nodes, not in Git, never pasted into a prompt.
  A run gets write-once copies outside the checkout (`run-context/<runId>/references/` in the
  project's scratch directory) and reads them itself; each copy's revision is recorded in the
  run's resolved context, so later edits never change what an earlier run saw. Drafting one
  from a conversation is a single tool-less completion over that node's own messages and
  `CONTEXT.md`, not an agent run, and returns text for the user to edit and save.
- `@experiment` and Compare read other experiments only through snapshots of their COMMITTED
  work (`jobs/experimentSnapshot.ts`): conversation, committed diff and notes, never uncommitted
  work. A comparison's agent gets Read, Glob and Grep and nothing else, enforced by the `tools`
  option and the permission callback; it never runs commands and never touches an experiment.
  Its snapshots live in the project's scratch `compare/<id>/`; files are exported with
  `git archive`, not a registered worktree. References attached to a comparison question are
  write-once copies in `compare/<id>/_questions/<questionId>/` (a leading `_` cannot collide
  with an experiment folder), recorded on the question like a run's resolved context.
- Name-only children have no worktree. First execution allocates a detached checkout at
  the pinned base; modifying runs commit there and move the node's ref. Bonsai creates no
  branches: a checkout still on a `node/<uuid>` branch from an older version commits there.
- Every node has a hidden ref, `refs/bonsai/<projectId>/<nodeId>`, at its tip
  (`head_commit ?? base_commit`): created with the node, moved by each commit with the old
  value as a guard, checked with the Git state, removed with the node (`git/refs.ts`). It is
  what keeps code git would otherwise prune. A ref pointing elsewhere is drift: report it,
  never move it to match the database. Startup, allocation and runs pin nodes that have none.
- An archived experiment (`node.archived_at`) has no worktree either, and keeps its branch,
  ref, rows and session. The next allocation checks it out again at the SAME path (the SDK
  finds the session by cwd), on its branch if it has one and detached at its tip otherwise,
  and setup runs again (`setup_ran_at` is cleared on archive).
  Never archive a running node, one with uncommitted work or drifted Git state, or the user's
  own folder; ignored files that setup or a build cannot recreate need the user's
  confirmation. Review and notes read an archived node's commits from the repository. See
  `archive.ts`.
  The app commits; the agent must not create branches/worktrees or rewrite Git state.
- Children do not freeze parents (approved Phase 3). Existing children never move to newer
  parent code automatically. An adopted project's master is read-only (`isAdoptedRoot`): a
  detached checkout of the adoption snapshot in Bonsai's folder, created on first use, which
  never follows the user's folder. Projects adopted earlier keep the user's own folder as
  master (`isUsersOwnCheckout`): never written, archived, discarded or deleted.
- Git state checks detect unexpected HEAD/ref/common-repository changes before execution,
  commit and deletion. Preserve drifted work; never silently reset it to match the database.
  Run saving computes a commit with `commit-tree`, records its exact identity and database
  consequences in `run_save`, then moves the checkout tip and node ref in one Git CAS
  transaction. Startup finishes only a matching durable Bonsai save. Unknown changes use
  the panel's explicit synchronization choices, which first create an independent recovery
  repository with ignored files, staged content and known tips. Existing branches retain
  their tips; reconciliation detaches the owned checkout. A missing repository or foreign
  checkout is reported and is never reset. Full repository exports have their own Git objects
  and history and must remain usable after the source Bonsai storage is removed.
- Confirmed deletion records an immutable cleanup intent before removing files. Restart
  resumes only matching owned state; failure stays visible and offers retry or cancellation
  while recorded commits remain recoverable. Never delete an unallocated folder or override
  a Git worktree lock. Recovery copies live outside the project's deletion directory.
- Moving managed storage repairs only verified owned worktrees and journals the path move
  before Git repair. Never guess a moved external repository: the explicit Locate repository
  action verifies saved project refs and recorded commits. Do not displace a still-existing
  checkout from another copy of Bonsai. Project settings can recover experiments omitted from
  an older database; project deletion refuses unrecorded Git work until it is recovered.
- Worktrees are separate checkouts, **not security sandboxes**. Writable commands retain
  host access. The Git command hook is a cooperative guard, not arbitrary-code containment.
  Scoped external approval is future work, not an existing guarantee.
- Apply to your repo only writes a patch into Bonsai's data folder and shows the
  `git apply --3way` command (`api/applyPatch.ts`), or serves the same file as a download.
  Bonsai never writes to, commits in or merges into the user's repository; running the
  command is the user's. Review and Apply take a scope (`ChangeScope`): `own` since the
  experiment's base, or `line` since the line left master (`git merge-base`). Review defaults
  to `own`, Apply to `line`: the user's folder is at master's code.
- New projects put run notes at their recorded `project.notes_path` under `.bonsai/`,
  independently of the selected working subdirectory. Existing projects retain their
  recorded `CONTEXT.md` notes path for compatibility. Only that project's notes file has
  special commit/Apply behavior; preserve ordinary repository documentation.
- Setup is skipped for read-only runs. Copy-in files must be untracked and ignored in the
  destination; reject unsafe paths and failed inspections. Never copy dependencies.
- Runs are asynchronous. Every exit must finalize state and release the execution slot.
  Use bounded process cleanup, preserve partial work and report incomplete cleanup.
- Use real Git regression tests for ownership, commits, snapshots, recovery and deletion.
  Do not add ceremonial lifecycle helpers disconnected from the API/job implementation.

Later phases (standing references, running procedures across compared experiments, notes
migration, scoped external actions, applying changes on the user's behalf and additional SDK
capabilities) require their own
scoped implementation work.
