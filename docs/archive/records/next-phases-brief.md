# Next phases — planning brief

Base: `codex/stabilize-a-d` (`7d25e8c`), i.e. after stabilization A–D.
See `docs/stabilization-a-d.md` for what that milestone did and what it left open.

## How to read this

This is **intent, not a specification**. Each phase says what problem it solves, what
should be true when it is finished, and which constraints must survive. It deliberately
does not say how.

Where a path is obvious to you and different from anything implied here, take yours —
but say so in the commit message, because a departure is usually where the reasoning
below turns out to be wrong, and that is worth recording.

**Verify before you trust this document.** The findings marked *checked* were read off
`7d25e8c` during planning, but they were spot checks, not audits — read the code before
relying on any of them. Findings marked *assumed* were inferred and were not opened at
all. If something here is wrong, the phase is still probably right and the reasoning
is what needs correcting; flag it rather than quietly working around it.

## Standing rules these phases do not get to break

From `CLAUDE.md`, still in force:

- Runs are async jobs; start returns a job id, progress streams, cancel works.
- The backend owns the tree. The interface renders server state.
- Render from flags, never from a node "type" string.
- No git, filesystem or agent access in interface code. One API surface.
- Nodes are immutable: new commits only, never amend, never rewrite history.
- Ask before adding dependencies. Ask when the spec is ambiguous rather than picking a
  plausible reading.
- Small commits, one concern each. `npm test` green before every commit.

Two more that this planning added:

- A worktree is not a sandbox, and nothing here pretends otherwise.
- Anything that grows a run's context must be **pull-based**: the agent fetches what it
  needs rather than receiving it whether or not it is useful.

---

## Phase 1 — Reading what happened

**Problem.** The app's account of a run is easier to read than its evidence. The agent's
prose is prominent; the changed code is harder to navigate than the same change would be
in any editor. That asymmetry is wrong for a tool whose purpose is deciding which of
several attempts to keep — you need to be able to distrust the prose cheaply.

**What should be true when it is done**

- A command in the conversation can be read in full without breaking the page: bounded,
  scrollable horizontally, with bounded expanded output.
- A changed file can be read as a **file** or as a **diff**, switchable, without leaving
  the review.
- Line wrapping is a preference that persists rather than a per-view accident.
- Opening the node's actual folder in the user's own tools is one obvious action. Bonsai
  should be good at what an editor cannot do — comparing attempts — and easy to leave for
  everything else.

**What we checked**

- A `packages/ui/src/review/` module already exists (`Review`, `ReviewPane`-style
  components, `ReviewTree`, `diffModel`, `fileTree`, `useReview`). This phase extends it;
  it does not start it.
- `styles.css` still has one `white-space: pre` (around line 1558 on this base) which is
  consistent with the "review renders code unwrapped" note in the stabilization doc.
  Confirm that is the rule actually governing changed-file rendering before changing it.

**Assumed, worth confirming**

- Whether a whole-node diff (everything a node changed against its base) is reachable in
  the interface at all, as distinct from the per-run diff. A `GET /api/nodes/:id/diff`
  route and a client method existed earlier in the project's history and appeared unused
  by the interface; the review rewrite may have changed that. If it is genuinely unused,
  wiring it is most of a feature for very little work.
- Whether uncommitted work in a node's worktree is visible anywhere. `nodeDiff` computed a
  `dirty` list historically. "What is in the folder right now" is worth surfacing.

**Constraints.** Interface-only. If this phase needs a server change beyond wiring an
existing route, something has been misjudged — stop and say so.

---

## Phase 2 — Project context and reopening

**Problem.** There is no sense of which project you are in or what else exists. Reopening
an existing project is harder than making a new one, which is how duplicates get created.

**What should be true when it is done**

- The current project is identifiable at a glance, including **where it actually is**:
  repository path and working subdirectory, not just a name.
- Every existing project is reachable and distinguishable, including two projects on the
  same repository.
- Choosing a folder that already has projects offers **opening one of them** as the
  primary action, with creating another there available but secondary.

**What we checked**

- `GET /api/projects` returns the full `projectView(p)`, while the interface narrows it to
  `{ id, name }` in `ProjectSummary`. If that still holds, most of what this phase needs
  is already on the wire.
- A project picker already exists in `MenuBar` with styling in `styles.css`. Extend it
  rather than introducing a second way to switch projects.
- **There is no `UNIQUE` constraint on `project.repo_path`.** The only unique constraint in
  the schema is `message(node_id, seq)`.
- `project.work_dir` exists and is documented as the agent's working directory relative to
  the repository root. Same repository, different subdirectory is therefore already a
  supported shape, not a new feature.
- Project deletion iterates that project's own node rows when removing worktrees and
  branches, so one project's deletion should not reach another's work on the same
  repository. **Re-verify this before relying on it** — it is the assumption the whole
  "multiple projects per repository" position rests on.

**Position taken.** Multiple projects on one repository are **allowed**. Do not add a
constraint; add disambiguation. Warn at the picker, never block.

**One hazard.** Deleting a *created* (not adopted) project appears to remove
`dirname(repo_path)`. Created projects each get their own generated folder, so they cannot
collide today — but that is a property of how paths are generated rather than an asserted
invariant. This phase invites users to think about shared directories, so pin it with a
test.

---

## Phase 3 — When a run's context is resolved

This is the structural phase. The four items below are one change wearing four hats: they
all answer *when is a node's context decided, and what does a child's existence do to its
parent*. Splitting them means changing the same invariants twice.

**Problem.** Today a child's inherited conversation is fixed the first time it runs, and a
parent's code freezes once a child commits. Both make "create a node now, talk to it later"
produce a node with stale inherited context and a parent that can no longer be used.

**What should be true when it is done**

- **Create-only exists.** Creating a node starts neither setup nor the agent. A name is
  enough; everything else is fillable later.
- **Inherited conversation refreshes.** Before each new message or run, the inherited
  parent conversation is re-resolved. Once a run starts, its resolved context is fixed for
  the duration of that run.
- **Each run records the context it actually used.** "Which conversation and which revision
  did this run see" is answerable afterwards.
- **A child does not lock its parent.** The parent stays available for further work.
  Existing children keep the revision they inherited. Later parent commits never silently
  alter an existing child's code.
- **Being behind the parent is visible** on the child.

**What we checked — this is smaller than it looks**

- `resolveBaseCommit` already pins the child's base. *"Later parent commits do not silently
  alter an existing child's code"* already holds. You are not building that guarantee; it
  exists.
- `divergesFromLiveWalk` already computes "this node's pinned base is behind the live
  walk", it already reaches the interface as `baseIsPinnedBehindLiveWalk`, and `Panel.tsx`
  already renders a note for it. The "child is behind" signal exists and may only need to
  be made louder.
- The freeze is `isWritable(children) = !children.some(c => c.headCommit !== null)` in
  `domain/flags.ts`. Given the pinned base above, it is not protecting anything technical —
  it is a modelling choice. Removing it is closer to deletion than to construction.
- Removing it should **dissolve the queued-run freeze-authority checkpoint** described in
  `docs/stabilization-a-d.md` ("freeze authority is captured when a run is submitted…").
  If it does not, that is interesting and worth reporting.
- `resolveInheritance` currently forks the parent's session only while the child has no
  `session_id` of its own. That is precisely the staleness: once a child has run once, the
  parent is never consulted again. The refresh is the real work in this phase.

**Position taken: allocate the worktree lazily.** Create-only should be instant and free; a
node nobody talks to should not cost a `git worktree add`; and lazy allocation means a node
with no worktree at all (Phase 4's notes) falls out of the same path instead of becoming a
special case. Phase C already put setup inside the failure boundary, so allocation-can-fail
machinery exists. If lazy turns out to be materially worse than eager once you are in the
code, say so — this is a judgement call, not a finding.

**Explicitly not in this phase.** "Update from parent" — bringing an existing child forward
onto newer parent code, with review and conflict handling. Agreed as later work. Do not
build toward it beyond making the divergence visible.

**Left open**

- Whether `writable` survives as a concept at all once the freeze goes, or collapses into
  "is this the user's own folder".
- What refresh means for a child whose parent gained many turns since: the whole new tail,
  or something bounded. Cost is the constraint; correctness is not at risk either way.

---

## Phase 4 — References

**Depends on Phase 3.** References need a settled answer to "what is a run's resolved
context" before they can be added to it.

**Problem.** Work in one node cannot reach another. Siblings cannot see each other's
results, and there is nowhere to keep project knowledge that several nodes need.

**Two things, one mechanism.** A reference points either at **a node** or at **a note**.
A note is a stored document with its own conversation, no worktree, no git, no commits;
you talk to an agent to develop it and can edit it directly. Both ends use the same
relationship, the same gesture, and the same access path. Building them separately would
be building the same feature twice.

**How context reaches the agent — this is the important decision.**
References are **materialized as files** in the node's worktree, under something like
`.bonsai/references/`, excluded from what gets committed. The agent reads them with `Read`
and searches them with `Grep` — tools it already has.

The reasoning, so you can judge a departure:

- It is **pull-based**. Context grows only when the agent actually looks, and only by what
  it looks at. Injecting reference content into prompts does not scale past a couple of
  references and spends tokens on material that may go unused.
- It needs **no new dependency**. The in-process MCP alternative (`createSdkMcpServer` /
  `tool()`) requires Zod, which is not currently a dependency. If you find a strong reason
  to prefer tools over files, that is a dependency conversation to have with the user
  first, not a decision to make inside the phase.
- It comes with useful properties for free: the agent's `Read` shows in the transcript, so
  *attached* and *actually consulted* are visibly different; and the user can open the same
  files in their own editor.

**What should be true when it is done**

- Attaching a reference to a message is fast and familiar. The intended gesture is an
  `@`-mention in the composer — it is a message-time act, because you reference something
  because of what you are about to ask.
- What a message will carry is **visible before sending**, itemised, removable, with its
  size. Context should never be invisible at the moment you commit to spending it.
- Some references are standing rather than per-message: pinned to a node or a subtree and
  attached automatically, still removable for a single message.
- A node's own result can become a note in one action, seeded from what it already
  produced. This is the flow the whole feature came from — *I have results and the sibling
  cannot see them*.
- Referencing a **node** should reach its artifact (its `CONTEXT.md`, testing notes,
  diffstat), never its raw transcript. A transcript is orders of magnitude larger and
  worse.
- A reference materialized for a run is **snapshotted with its revision recorded**. Editing
  a note next week must not retroactively change what last week's run saw.

**Constraints and traps**

- The materialization directory must be excluded from what a run commits. Phase B's
  destination-ignore-rule work is the relevant machinery. Handle the case where the user's
  own repository already contains that path.
- Notes are the first mutable thing in the tree. That is intended — immutability is about
  code and reproducibility — but it should be a recorded decision, and revisions are how
  the spirit of the rule is kept.
- Notes should not need canvas real estate. With `@` as the access path they can live in a
  drawer; the canvas stays experiments only.
- Do not let this become a node "type" string in interface code.

**Left open**

- Whether a note can reference another note, which the file-materialization route does not
  naturally serve (a note has no worktree).
- Whether pinning is scoped to a node and inherited by its subtree, or listed explicitly
  per node. Subtree inheritance was the favoured direction: it avoids an edge per node for
  something that applies broadly, and it matches the existing project-default-with-override
  pattern.
- How references appear on the canvas, if at all. Deliberately undecided. The principle
  agreed was **draw the exception, not the rule** — a relationship that is always present
  carries no information and should not cost a line.

---

## Phase 5 — SDK capability matrix

**Problem.** "Support all Claude Code SDK features" is not actionable, and some features
would route around Bonsai's own history or permission model if exposed naively.

**Do the audit before any code.** Produce a matrix, pinned to the SDK version in the
lockfile, of what exists, what Bonsai already uses, and what a candidate would cost. It is
a document, and it is the whole first deliverable.

**One admission rule.** A capability is a candidate only if its effects still flow through
Bonsai's message log and its permission gate. Anything that bypasses either is not
low-hanging fruit regardless of how easy it looks.

**What we checked.** Background-task visibility is at least partly present already
(`stopTask`, `background_tasks_changed` appear in the SDK runner). Do not re-plan what is
built.

Candidates raised in planning, unranked and unverified: steering, queued follow-ups,
model/command discovery, partial streaming, limits reporting. Verify each against the
pinned version rather than against documentation or memory.

---

## Deliberately out of scope

- **External changes (Caddy and similar).** Current behaviour stands: the agent explains
  what the user must do and does not do it. A controlled executor with an enforceable
  boundary is a sandbox, and there is no honest cheap version. Since the agent only
  instructs, the record is already in the conversation, so there is nothing to build.
  Make sure the prompt guidance is clear and consistent; do not build recording machinery.
- **"Update from parent."** See Phase 3.
- **Merging nodes, multiple parents, Apply.** Not in these phases.

## Ordering

1 and 2 first: they are small, carry no structural risk, and 1 directly addresses how hard
the app currently is to see into. 3 before 4, always. 5 can start as a document at any
point, since its first deliverable is not code.

## Decisions worth recording as you go

These changed or will change previously recorded positions, and should land in
`docs/v0-decisions-and-backlog.md` rather than only in commit messages:

- Parent nodes no longer freeze when a child commits; the pinned base is what protects a
  child, and divergence is surfaced instead.
- A run's inherited conversation is resolved per run, not once per node, and what it
  resolved to is recorded.
- Multiple projects may share a repository path; disambiguation replaces prevention.
- References are pull-based files in the worktree, not injected prompt content.
- Notes are mutable; their revisions are not.
