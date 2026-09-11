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
| D4 | A node is writable **only while it is a leaf**; it freezes once it has a child. | Frozen nodes stay conversational (inquiry), just not writable. |
| D5 | To make a change you **explicitly create a child**: name + description + confirm. The agent then works inside that child. | Node granularity is a user decision, not an agent side effect. Prevents node spam. |
| D6 | **Change vs. exploration is emergent, not chosen.** A node whose agent wrote no code is an exploration node. | Replaces the draft's contradictory "pick the type twice" flow. |
| D7 | **Delete cascades** to descendants. | See B9 — soft delete recommended, not adopted. |
| D21 | On project creation, the **agent scaffolds starter code** from the project description. Master is not empty. | "Do nothing" is a valid instruction — you still get a repo, a README, and an initial commit. |
| D24 | **Master is a real git branch.** It's the one node that always has one; a repo needs a default branch with a commit for anything to branch from. Otherwise master behaves like any other node (freezes when it gets a child). | No special-casing beyond this. |
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
| D37 | **Existing branches are not turned into nodes.** | Not a shortcut not taken. Branches form a DAG rather than a tree (B11), git does not record which branch forked from which, and decisively an imported branch carries no conversation — the one thing a node passes to its children. It would be an empty shell with a name. |

### Agent integration

| # | Decision | Notes |
|---|---|---|
| D15 | Use the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), not the raw API. | Same harness as Claude Code: file editing, search, bash already reliable. |
| D16 | **Memory across nodes = session forking.** Child = `query({ resume: parentSessionId, forkSession: true, cwd: nodeWorktree })`. | Full ancestor history, parent untouched, siblings invisible. D2 becomes a config flag. |
| D18 | **`allowedTools` restricted to read-only** for exploration nodes and frozen nodes. | Enforcement, not instruction. |
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
