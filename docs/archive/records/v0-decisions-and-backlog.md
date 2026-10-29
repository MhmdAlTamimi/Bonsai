> Historical design record. Read README.md and AGENTS.md for current behavior and contributor instructions. This document is not a current scope or acceptance gate.

# Mindmap Agent Tool — V0 Decisions, Backlog & Open Questions

Working document. What's decided, what was pushed to later versions, and what's
still unanswered. Not the spec itself.

---

## 1. Product shape

A visual mindmap where each node is an AI agent session bound to a git branch.
You explore ideas as a tree of experiments and see how they relate, rather than
losing them in a single linear chat. V0 optimizes for **visualizing experiments**,
not for shipping code.

---

## 2. Decided (locked for V0)

### Tree & node semantics

| # | Decision | Notes |
|---|---|---|
| D1 | The graph is a **tree**. `master → A → C` and `master → B → exploration 1` are separate lines. | Siblings are fully isolated. |
| D2 | A node inherits the agent session history of **its ancestor chain only**. | Implemented by session forking — see D16. |
| D3 | **Nodes are immutable.** No editing a node in V0. | Removes the rebase / stale-descendant problem entirely. |
| D4 | A node’s code is writable **while no direct child has commits**. Question-only children do not freeze it; deleting the last committed child unfreezes it. Owner confirmed 14 September 2026. | Frozen nodes stay conversational (inquiry), just not writable. |
| D5 | To make a change you **explicitly create a child**: name + description + confirm. The agent then works inside that child. | Node granularity is a user decision, not an agent side effect. Prevents node spam. |
| D6 | **Change vs. exploration is emergent, not chosen.** A node whose agent wrote no code is an exploration node. | Replaces the draft's contradictory "pick the type twice" flow. |
| D7 | **Delete cascades** to descendants. | See B9 — soft delete recommended, not adopted. |
| D21 | On project creation, the **agent scaffolds starter code** from the project description. Master is not empty. | "Do nothing" is a valid instruction — you still get a repo, a README, and an initial commit. |
| D24 | **Master is a real git branch.** It's the one node that always has one; a repo needs a default branch with a commit for anything to branch from. Otherwise master behaves like any other node (freezes when a direct child commits). | No special-casing beyond this. |
| D25 | **A node forks two independent things: code (a git branch) and conversation (a session fork).** A change node forks both. An **exploration node forks only the conversation** and sits on its parent's commit. | Not two node classes — one node with two flags: `creates_branch`, `writable`. First step toward B10. |
| D26 | Exploration nodes get a **detached worktree** (`git worktree add --detach <path> <commit>`) plus **read-only `allowedTools`** (no Write/Edit/Bash). | Isolated directory, no branch, no commits. Any stray write lands somewhere harmless instead of dirtying a frozen parent's checkout. Keeps the runner rule uniform: every node has a `cwd`. |
| D27 | To act on an exploration, you **create a child**, which gets a real branch and forks the exploration's session. | Silently promoting an exploration to a change node would break D3. |

### Git & ownership

| # | Decision | Notes |
|---|---|---|
| D8 | **The app owns the repo and is the source of truth.** It creates branches, commits, and later merges. The user never types a git command. | |
| D9 | **Projects are created from scratch inside the app.** No importing existing repos in V0. | Sidesteps the dirty-working-tree problem. **Superseded in part by D36** — a folder can now be adopted, though its branches still do not become nodes. |
| D10 | The user's own copy of the code is **separate**; seeing app changes there needs a sync step. | Sync deferred — B2. |
| D11 | **No merge feature in V0.** Branches accumulate. | |
| D12 | Auto-commit after agent work, message generated from the node description. No staging or commit UI. | |
| D17 | Each node gets its **own git worktree**; that directory is the agent's `cwd` and the isolation boundary. | One shared `.git`, real branches, parallel agents, main checkout untouched. |
| D19 | The agent is **blocked from running git itself** (hooks / tool restriction). The app commits. | An agent creating branches behind your back would corrupt the tree. |
| D36 | **A directory the user already has can be adopted, and is used in place.** Nothing is copied or moved: that folder IS the project's repository, master is that folder on the branch it is already on, and nodes are `node/<uuid>` branches inside the user's own repo with worktrees under Bonsai's directory. | Answers most of B4. Three consequences, all deliberate: **(a)** master is read-only from creation, not from its first child — its worktree is the user's checkout on the branch they work on, so Bonsai must never write there; **(b)** export becomes unnecessary, because the output is already a branch in their repo; **(c)** deletion becomes the dangerous path, so Bonsai removes only what it created — ownership is decided by `source_kind` and a `node/` prefix, never by a name comparison. |
| D38 | **A node may carry a definition of done** — what should be true, and how to check it — asked at creation, sent with every run, and answered by the agent in a `## Testing` section of CONTEXT.md. | Both optional; empty is exactly the previous behaviour. **No verdict is stored and there is no outcome enum**: whether "11 of 14 pass" counts as working is a judgement about the project, and a flag derived from prose would be a guess presented as a fact. Answers the half of the premise that was missing — recording experiments without helping judge them. |
| D39 | **A new node's worktree is seeded**: configured files are copied in at creation, and a per-project setup command runs once before the agent's first message. | `git worktree add` checks out tracked files only, so without this the agent lands somewhere the tests cannot run and D38 reports "could not check anything" every time. Copied never linked; a git-TRACKED file is refused rather than copied, because `git add -A` would commit it. Dependencies are regenerated, not copied — node_modules is enormous per node and a virtualenv bakes in absolute paths. |
| D41 | **A folder inside a repository can be opened, the way an editor opens one.** The nearest enclosing repository is the project's identity; the folder that was chosen is the agent's working directory inside every node's worktree (`project.work_dir`, relative to the repository root, `''` for the root itself). Owner-approved 15 September 2026. | Adopting a subfolder used to be refused with advice to pick the root, which made a monorepo an all-or-nothing choice. Four consequences, all deliberate: **(a)** git still sees the WHOLE repository — commits, history, branches and diffs are unchanged, and a run that writes in the working directory commits at the file's repository-relative path; **(b)** Bonsai never `git init`s inside someone's repository and never invents a branch because a subfolder was chosen — the repository keeps its current branch; **(c)** nested repositories and submodules resolve to the NEAREST enclosing one, which is the repository the user's own git commands would act on standing there; **(d)** a folder in no repository at all is still initialised as one, where it is. Created projects keep the repository root as their working directory; generalising to them can wait for a real case. |
| D37 | **Existing branches are not turned into nodes.** | Not a shortcut not taken. Branches form a DAG rather than a tree (B11), git does not record which branch forked from which, and decisively an imported branch carries no conversation — the one thing a node passes to its children. It would be an empty shell with a name. |

### Agent integration

| # | Decision | Notes |
|---|---|---|
| D15 | Use the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), not the raw API. | Same harness as Claude Code: file editing, search, bash already reliable. |
| D16 | **Memory across nodes = session forking.** Child = `query({ resume: parentSessionId, forkSession: true, cwd: nodeWorktree })`. | Full ancestor history, parent untouched, siblings invisible. D2 becomes a config flag. |
| D18 | **Read-only runs are enforced by the permission callback, not by `allowedTools`**, for frozen nodes and an adopted project's master. Reads are pre-approved; every other tool, named or not, is denied; the permission mode is forced to `default` for these runs. Corrected 16 September 2026. | Enforcement, not instruction. The original wording trusted `allowedTools` to restrict, and verified against the real SDK it does not: the list only pre-approves, and `acceptEdits` approves writes before it is consulted. A read-only run so configured created a file on request, and a real one ran Bash in an adopted project's own folder. `scripts/probe-agent-permissions.mjs` re-checks this against the SDK. |
| D20 | **Capture cost/tokens per node** from the result message, from day one. | Nearly free; prevents a nasty surprise later. |
| D22 | `CONTEXT.md` is a **single human-readable record** shown in the side panel — not the agent's memory. | Memory is D16. |
| D23 | Auth supports **both an API key and subscription login**. | |

| D28 | **The agent writes `CONTEXT.md`** as its final action; the **app commits**. Exploration nodes get no `CONTEXT.md` in V0. | Agent touches files, app touches git. Exploration nodes are read-only and their value lives in the session anyway. |
| D29 | **Always new commits, never amend.** A node is a branch that may accumulate several commits while it is still a leaf. | Amending rewrites history, breaks children that already forked, and destroys the only undo. |
| D30 | D19 refined: the agent is blocked from **mutating** git only (commit, branch, checkout, merge, reset). **Read-only git is allowed and expected** (`status`, `diff`, `log`). | A blanket block would break interrupted-run recovery. |
| D31 | **Interrupted runs are recoverable.** On reopen or failure the node is marked `interrupted`; the app injects the current working-tree state into the resume prompt and offers resume / discard / keep. | Closing the app kills the SDK subprocess, leaving a dirty worktree with no commit. Same mechanism covers mid-run failure. |
| D32 | **Permission mode and model are agent settings**: project-level default with per-node override. | |
| D33 | **Branch name and display name are decoupled.** Branch is `node/<uuid>` — generated once, never changes, never shown. Display name is renameable metadata. | Renaming a node never touches git. |
| D34 | **Side panel states:** new (name + description + start), running (streaming output, cancel), needs you (question + reply), ready (transcript, diff, cost, create child), interrupted/failed (transcript, resume/discard). | |
| D40 | **`needs_you` is the permission callback.** Under the `default` permission mode a writable tool call is held in `canUseTool` until the user answers; the node sits in `needs_you` meanwhile, and a refusal's message is handed back to the agent as the tool's result. | The state was specified in D34 and unreachable until now, which is why `default` was kept out of the settings picker. Read-only tools are approved without asking — with `settingSources: []` there are no rules to pre-approve anything, so every `Read` would otherwise be a question. A free-text "ask me anything" tool was the alternative and needs Zod (`createSdkMcpServer`/`tool()`), a dependency this does not. A parked run keeps its concurrency slot, because it still holds a live agent; stopping the node resolves the question as a refusal and frees it. |
| D42 | **A question the agent asks parks the run in every permission mode, read-only runs included.** When the agent calls its AskUserQuestion tool the run waits in `needs_you` with the questions and their options; the user answers (any text — an option or their own), leaves the decision to the agent, or stops the run. There is no timeout. Owner-approved 16 September 2026; amends D40, which tied `needs_you` to the `default` mode. | A permission mode says whether Bonsai checks before the agent ACTS; a question is not an action, and tying it to the mode is what broke it — under `acceptEdits` the tool returned at once with no answer and the agent wrote "I'll wait for the user" into a run that then ended. The SDK delivers answers only as `answers` in the tool input the permission callback returns; verified against the real SDK in all four modes and on read-only runs. Leaving it to the agent is a refusal whose message tells it to choose and say what it chose, because a refusal's message is what reaches the agent. No timeout: a question that silently expires is the same trap. Stored in the existing `question.request_json` with `kind: 'choice'`, so no migration and old rows read unchanged. |
| D43 | **A run ends when the work ends, not when the agent's turn does.** The session is held open with streaming input; a turn that ends while background work the agent started is still live leaves the run `running` and waiting. Tracked jobs come from the SDK's live background set (its own watchers excluded); processes detached with nohup, setsid or `&` are found by a `BONSAI_RUN_ID` marker every agent process inherits, and the agent is told when they exit. There is no timeout. **Finish now** stops the work and ends the run normally, so it commits; **Stop** cancels. Nothing a run started outlives it. Owner-approved 16 September 2026. | The incident: `uv sync` and a batch job started in the background; Bonsai committed and said Finished at the end of the turn, the SDK stopped the tracked job seconds later, and the detached one kept writing into a finished experiment. Verified against the real SDK: single-prompt mode stops tracked jobs about five seconds after the turn; a held-open session lets them finish and wakes the agent. No timeout because a training run and a dev server look identical from here — the user decides with Finish now. Detached-process detection is Linux (`/proc`) and macOS (`ps`); Windows finds none, a documented limit. The agent is also told to use background mode and never to detach; asked outright to use nohup, it refuses. |
| D45 | **A run records why it ended — finished, stopped, failed or app closed — and recovery is worded by that.** The notice and the prompt the agent receives come from one shared rule. A finished run whose files changed afterwards is never called interrupted: the agent is asked to review the changes. Each run also records how many jobs had to be stopped and what its own commit changed. | "Resume run" used to tell the agent it had been interrupted after every kind of ending, including a normal finish; the agent believed it and stopped. Stops and app exits are facts, not error prose, so `error` now holds only a failure's message. Migration 14 backfills older runs from their status. |
| D46 | **One interface geometry, and review is a screen of its own.** Owner-supplied design, approved 18 September 2026, replacing the tabbed panel of the reverted D44. Surfaces separate by value (void #0b0c0e → canvas #0e0f12 → panel #131519 → control #1b1e24), never by a rule; one accent, one mono for every path, number and diff; type is 13 / 12.5 / 12 / 11.5 / 11 / 10.5 / 10 and heights 52 / 44 / 36 / 32 / 30 / 28 / 26 / 24 / 22 / 21 / 20, all in rem so they grow with the text size. **The panel is the conversation and nothing else**: runs are its unit, your message is an object on the panel and the agent's reply is text; a command or an edit is a block showing what it produced, and everything else — reads, searches — is one dim line. **Changes are read on a full screen** opened from the card: a file tree at 272, one or two diff panes, and the conversation docked beside it at 285 or collapsed to a 46px rail (⌘\\). Checks, lineage, details and checkout stay in the panel, folded away under the conversation. | The Changes tab was overwhelming for the run that prompted this: every file a box, the first four open on every load, and the same diff repeated inside the conversation. A tab is the wrong container for something that wants the whole window, and floating windows (D44) were the wrong answer — they made the user a window manager. Nothing leaves the app, which is the constraint the owner set and the reason review is a screen rather than an editor hand-off. The design's dimmest steps were lifted where they carry text, because several were below 4.5:1 on the panel. |
| D47 | **The panel answers one question: what was asked, what the agent did, what it said.** Owner-supplied conversation-panel notes, approved 18 September 2026; extends D46. Anything that is a property of the NODE goes to the card's ⋯ (goal, lineage, code state, created, runs, node id, agent notes); anything that is a view of the experiment's FILES goes to the review screen, whose own ⋯ carries the recorded checks and the checkout command; settings for a run that has not happened go into the composer's ⋯; branching is a canvas action. Three rules hold the rest together: **one scroll** (the thread — the composer's box is the single exception, growing to five lines and then scrolling, so Send never leaves the window), **one disclosure** (a 24px caret row, the same shape everywhere), and **one bounded block** for machine output — READ / RUN / EDIT in one shell, eight lines, a copy button always present, never an inner scroller. Your own request is clamped to six lines. The conversation is 380 wide on the canvas, collapsed to a 46px rail when review opens, and 285 when ⌘\\ brings it back; each mode remembers what you last did to it. | At 285px the panel carried the node's facts, the experiment-wide file list, a checkout command and a future run's settings, and the reply you came to read started below the fold. Everything removed has a home where it is already in context, so nothing is hidden — it is filed. The bounded block replaces both the untrimmed command output and the "Read ×6 · Grep ×2" summary, which hid WHICH file was read at the moment it mattered; a read is now one 30px row, which is what a read is worth. A command keeps the END of its output, because that is where it says how it went. |
| D35 | **Canvas is a left-to-right auto-laid-out graph**; node detail thins as you zoom out (full card → name + status dot → dot). | Radial degrades badly on deep chains, and depth is the normal case here. |

### Platform & architecture

| # | Decision | Notes |
|---|---|---|
| D13 | **Local**, not hosted. Local backend process serving a browser UI on localhost; wrap in Electron/Tauri later. | Hosted would mean sandboxing agent-run code, multi-tenancy, and compute billing — bigger than the product. |
| D14a | **TypeScript end to end.** | Wraps into a desktop shell with no sidecar-binary pain; shares a language with the UI. |
| D14b | **Nothing touching git, the filesystem, or the agent lives in UI code.** One API surface, no exceptions. | The one thing that's almost impossible to retrofit. |
| D14c | **State in SQLite** in an app data directory. Never browser storage. | Browser state can't follow you to a desktop shell. |
| D14d | **Agent runs are async jobs from day one**: start returns a job ID, progress streams (SSE/websocket), cancellation exists. | Retrofitting streaming and cancel onto sync calls is genuinely painful. |
| D14e | Repo path is config, never hardcoded. Agent invocation sits behind one interface. | Makes swapping model/harness cheap. |

### Design notes

- **Git is not version control here.** It's a cheap snapshot-and-isolation
  mechanism giving each agent session a consistent view of the code. Priority
  follows: never bother the user about git. Clean history is worth nothing;
  isolation is worth everything.
- **Forks are snapshots.** Chatting with a frozen node later does not affect
  children that already forked from it. Immutability (D3) holds at the memory
  layer too, not just in git.
- **Code lineage and context lineage can diverge — handle it.** A child of an
  exploration node forks that exploration's *session* (carrying the whole
  conversation) but its *git base* is the exploration's parent commit, since the
  exploration has no commits of its own. The exploration node is invisible to git
  and fully present in the conversation.
- **Consequence:** branch creation cannot use `parent.commit`. It must walk up
  until it finds the nearest ancestor that has one. Chained explorations
  (exploration → exploration → change) make that walk more than one hop. This is
  the single easiest thing in the design to get subtly wrong.

---

## 3. Deferred — "later on" backlog

Ordered roughly by when it starts to hurt.

**B1 — Getting code out / merging to main.** No path back to main in V0. Later: a
merge action in the mindmap, or export (patch file / push branch for PR). Merging
in-UI means owning conflict resolution — large project on its own.

**B2 — Sync with the user's working copy.** Direction, conflict behaviour, and
one-way vs. two-way all undecided.

**B3 — Conflict resolution / "cleaning agent."** Deliberately unexplored. Needed
as soon as B1 or B2 lands.

**B4 — Importing an existing repository.** *Largely landed, as D36/D37.* A folder
can be adopted and used in place; uncommitted changes are handled by an optional
`git stash create` snapshot that commits nothing to the user's branch, and
branch-name clashes cannot happen because Bonsai only ever writes `node/<uuid>`.
What remains deferred is turning the repository's **existing branches** into
nodes (D37 says why that is a dead end rather than unfinished work) and anything
that would write back to the user's own branch, which is B1 and B2.

**B5 — Scalability of node count.** No merge and no pruning means branches
accumulate forever. Needs archive / prune / collapse-subtree / search.

**B6 — Cost UI.** Capture is in V0 (D20). Still to come: per-node display,
project totals, and a warning at some depth threshold.

**B7 — Context compaction.** Now an optimization on forking depth rather than a
guess: a fork at depth 6 replays everything above it. Later, swap in ancestor
diffs + summaries. Real ceiling, but no longer blocking.

**B8 — Running and comparing experiments.** No way to execute, test, or diff
nodes against each other. A tree of experiments you can't evaluate is hard to draw
conclusions from. Later: run command per node with captured output, side-by-side
node diff.

**B9 — Soft delete / undo.** D7 cascades hard. Agent runs cost money and are not
reproducible — the same prompt does not regenerate the same code. Archive instead
of delete so one misclick can't vaporize a subtree.

**B10 — Decoupling code lineage from context lineage.** Today they're the same
graph; they don't have to be. "A's code with B's conversation" is a legitimate
want and arguably the most differentiated feature available here.

**B11 — Merge nodes / DAG rendering.** A merged node has two parents; a mindmap
can't draw that and D2 has no answer for whose history wins. Blocked on B1.

**B12 — Multi-user, hosting, collaboration.** Single-user local for now.

**B13 — Per-node model selection.** Cheap model for exploration, stronger model
for changes.

---

## 4. Open questions

1. **Does master get its own worktree, or use the repo's main checkout?** Uniformity
   argues for its own; simplicity argues for the main checkout.
2. **Is there a cap on concurrent runs?** Several agents at once is the point, but
   unbounded parallelism will saturate a laptop.
3. **What happens if a node is deleted while running?** Cancel then delete, or block
   the delete until it finishes.
4. **When are exploration worktrees cleaned up?** They hold no commits, so they can be
   recreated on demand rather than kept forever.
5. **Which auth path is the default** when both an API key and subscription login are
   configured (D23).

---

## 5. Technical leads

- **Claude Agent SDK** — https://docs.claude.com/en/api/agent-sdk/overview
- **Session management & forking** — https://docs.claude.com/en/api/agent-sdk/sessions
  (`resume`, `forkSession`). Forking only branches from a session's latest state,
  not an arbitrary message — harmless here, since nodes freeze at their tip.
  Session files are machine-local: fine for a local app, another reason hosted hurts.
- **Packaging note** — the SDK runs Claude Code in a subprocess and ships a native
  binary per platform; plan for bundling that when going desktop.
- **`git worktree`** — the isolation primitive behind D17.
- **React Flow** — standard choice for node-and-edge UIs; panning, zoom, custom nodes.
- **Tree vs. DAG** — why merges break mindmap rendering (B11).
- **Three-way merge and rebase semantics** — background for B1 and B3.
- **Event sourcing** — the shape to reach for if immutability (D3) ever relaxes.


## 2026-09-21 — Phases 1–3 decisions (supersede historical freeze/fork rules)

- Multiple projects may share an original repository; the picker offers reopening first and
  distinguishes repository/working-subdirectory identity. Project deletion owns only its own work.
- Children no longer freeze parents. Code bases remain pinned at creation; no update-from-parent,
  history rewrite, merge or Apply was added. Adopted original checkouts remain read-only.
- Name-only creation saves metadata without allocating a checkout, copying files, running setup or
  invoking the agent. First execution allocates the pinned checkout inside the existing job failure
  boundary. Established missing/drifted work is never silently recreated.
- Every execution records its starting committed code revision, goals and parent conversation watermark.
  Parent conversation is automatically materialized as a fixed file outside the checkout, with a hash
  recorded on the run. The agent reads it on demand; child sessions resume their own history. This
  owner-approved approach replaces first-run-only SDK forks and avoids automatically injecting an
  ever-growing parent transcript. Old sessions retain existing history; current snapshots supersede
  previously inherited parent context. This is not a security sandbox or a context compactor.
- Review's full-file reads and saved wrapping require minimal server support; the owner approved this
  departure from Phase 1's original UI-only constraint after the existing API was inspected.

## 2026-09-25 — Conversation copy, compaction and references (supersede the per-run parent snapshot)

- A child copies its parent's conversation once, when it is created (an SDK session fork cut at
  the parent's last finished run), unless it is created with Start fresh. It then resumes only
  its own session; later parent turns never flow in. This replaces the per-run parent snapshot
  file above: a copied session is the conversation the child continues, and it no longer grows
  with every parent run. A failed copy leaves the child without it and says so in its thread.
- `/compact [focus]` runs as a read-only run that commits nothing, shown in the thread while it
  runs and as a divider afterwards (automatic compaction too). Compaction resets the copy's cut
  point, so later children copy the compacted conversation.
- References are project-scoped text written by the user, optionally drafted from a node's own
  conversation and `CONTEXT.md` by one tool-less model call whose output is edited before it is
  saved. They are attached per message with `@`, delivered as write-once files outside the
  checkout rather than under `.bonsai/references/` in it — which removes the commit-exclusion
  trap the brief anticipated — and snapshotted per run with their revision recorded. References
  are mutable; what a run received is not. Node references, standing (pinned) references and
  note conversations are not built.

## 2026-09-26 — Referencing experiments, and Compare

- `@` can name another experiment in the project. The run receives a snapshot of that
  experiment's committed work -- its own conversation, its committed diff and its notes -- as
  files to read when needed, recorded with its commit and run count. Committed work only, so a
  snapshot cannot change mid-run. The prompt asks the agent not to copy its code unless asked.
- Weighing several experiments against each other is its own screen, not an `@`: Compare takes
  two to four experiments, snapshots them (including their files at the compared commit, via
  `git archive`), and answers questions with an agent limited to Read, Glob and Grep. It runs
  nothing and changes no experiment, so experiments stay independent. Comparisons are kept per
  project; Update re-snapshots experiments that moved on and tells the agent once.
- Deliberately not built yet: a comparison running the same procedure in every experiment.
  The agreed shape for later is plan (agent) → approve (user) → run identically in temporary
  copies (Bonsai, no model) → interpret (agent), with fairness rules enforced by the harness.

## 2026-09-27 — The conversation groups what the agent did (supersedes D47's bounded blocks)

- Owner-supplied design ("Conversation panel · grouped tool activity"). Between two pieces of
  agent prose, every tool call folds into one dimmed summary line built from the steps --
  "Read chunk_writer.py, ran a command", with +added −removed when files changed and a red
  "N failed" when a command failed. It opens into one quiet container, a row per step; a step
  opens in place to its path and changed lines, or to `$ command` (with copy) and its output.
  The READ / RUN / EDIT kind chips, always-open headers and per-block exit tally are gone.
- A command's row uses the plain-language purpose the agent gave it (the Bash tool's
  `description`, now recorded with the call); older calls fall back to the command itself.
- Everything starts folded; what was opened is remembered for the session. A running stretch
  says what it is doing in the present tense ("Running pytest -q…") and stays folded.
- Body overflow follows the design's default: the first eight lines, then the 24px
  "N more lines" row. For command output this shows the start first (D47 showed the end); the
  summary's "failed" marker and the brighter last line carry how the command ended.

