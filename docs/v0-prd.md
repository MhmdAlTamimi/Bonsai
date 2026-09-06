# Mindmap Agent Tool — V0 PRD

Companion document: `v0-decisions-and-backlog.md` (decision log, deferred backlog,
open questions). Decision IDs below refer to it.

---

## 1. What this is

A visual tool where each node on a mindmap is an AI agent session bound to a git
branch. You explore ideas as a tree of experiments rather than losing them in one
linear chat.

The problem: when you explore several approaches with a coding agent, you either
lose the earlier ones or lose the conversation that produced them. Branches keep
the code but not the reasoning; a single chat keeps the reasoning but only the
last approach.

**V0 is about visualizing and running experiments, not shipping code.** There is
no merge, no sync, no import.

---

## 2. Definition of done

V0 is complete when this runs end to end:

1. Create a project; the agent scaffolds a small Python CLI from the description.
2. Branch twice from master with two different approaches.
3. Open an exploration node on one of them and ask a question about the code.
4. Spawn a child from that exploration node.
5. Confirm the child carries the exploration's conversation **and** branches from
   the exploration's parent commit.
6. Five nodes render on the canvas with correct ancestry, each session isolated
   from its siblings.

Anything not required by this script is out of scope by construction.

---

## 3. Non-goals

Named explicitly, because these are the adjacent-and-plausible things an
implementation will drift toward:

- **No merging** anything into anything (B1).
- **No sync** with the user's own copy of the code (B2).
- **No importing** an existing repository — new projects only (B4, D9).
- **No comparing** two nodes side by side (B8).
- **No editing** a node after it has children (D3, D4).
- **No conflict resolution**, no cleaning agent (B3).
- **No pruning, archiving, or search** over nodes (B5).
- **No multi-user, no hosting, no collaboration** (B12, D13).

---

## 4. Core concepts

A **node** is one agent session plus, usually, one git branch. It forks two
independent things from its parent:

| | Code (git branch) | Conversation (session fork) |
|---|---|---|
| **Change node** | yes | yes |
| **Exploration node** | no | yes |

There are not two node classes — one node with two flags, `creates_branch` and
`writable` (D25).

- **Master** is the root node and the only one guaranteed to have a branch (D24).
- A node is **writable only while it is a leaf**. It freezes when it gets a child
  (D4). Frozen nodes remain conversational, read-only.
- A node **may hold several commits** — chat with a leaf three times, get three
  commits, tree unchanged (D29).
- **Immutability**: nodes are never edited, commits are never amended, and forks
  are snapshots, so later chat on a parent cannot affect existing children (D3).

### Lineage divergence — the easiest thing to get wrong

A child of an exploration node forks that exploration's **session** (carrying the
whole conversation) but its **git base** is the exploration's parent commit,
since the exploration has no commits of its own.

Branch creation therefore cannot use `parent.commit`. It must walk up until it
finds the nearest ancestor that has one. Chained explorations make that walk more
than one hop.

---

## 5. Node states

| State | Meaning | Panel offers |
|---|---|---|
| `new` | Created, not yet run | Name, description, start |
| `running` | Agent working | Streaming output, cancel |
| `needs_you` | Agent asked a question | Question + reply box |
| `ready` | Done, nothing pending | Transcript, diff, cost, create child |
| `interrupted` | Run killed or failed midway | Transcript, resume / discard / keep |

`needs_you` matters more than it looks. With several nodes in flight, a node
silently waiting on you is otherwise indistinguishable from a finished one.

---

## 6. User flows

### 6.1 Create a project
Name + description. The app creates a repo, master branch, and worktree. The
agent scaffolds starter code and a README from the description; "do nothing" is a
valid instruction and still produces a repo with an initial commit (D21).

### 6.2 Create a change node
From a selected node: name, change description, confirm. The app creates a branch
`node/<uuid>` from the nearest ancestor commit and a worktree, forks the parent's
session, and starts the run. **The user stays on the canvas**; the new node
appears immediately in `running`.

On completion the agent writes `CONTEXT.md` as its final action; the app then
commits everything, message generated from the node description (D28, D12).

### 6.3 Chat with a leaf node
Resume the node's session in place. Writes are allowed; each completed exchange
that touches files produces another commit on the same branch.

### 6.4 Create an exploration node
Same flow, but no branch. Gets a detached worktree at the parent's commit and
read-only `allowedTools` — no Write, no Edit, no Bash (D26). No `CONTEXT.md`.

### 6.5 Spawn a child from an exploration
Ordinary change-node creation. Forks the exploration's session; branches from the
nearest ancestor commit (§4).

### 6.6 Interrupted run recovery
Closing the app kills the SDK subprocess, leaving a dirty worktree with no commit.
On reopen, the node is `interrupted`. Resume injects the current working-tree
state into the prompt — the agent knows what it *intended*, not what landed, so
the app runs the diff for it. Use `git status --porcelain` alongside `git diff`,
or `git add -A` first: plain `git diff` misses untracked files, so a newly created
file would be invisible (D31).

Discard runs `git checkout .`; keep leaves it dirty and resumable.

### 6.7 Delete a node
Cascades to all descendants (D7). Removes branches and worktrees.

### 6.8 Rename a node
Changes display-name metadata only. Branch names are `node/<uuid>`, generated
once, never shown, never changed (D33).

---

## 7. Interface

### Canvas
Pannable, zoomable, left-to-right auto-layout (dagre or elk). Node detail thins as
you zoom out: full card → name + status dot → dot alone (D35).

Node card: fixed width, display name, one truncated summary line, status pill.
Summary is the change description you typed; for `needs_you` it is the agent's
question instead, which makes the canvas triageable at a glance. Exploration
nodes are visually distinct (dashed border, chat icon) — they have no diff and
hiding that confuses people.

Failed and interrupted nodes stay visible. They still hold a transcript worth
reading.

### Side panel
Beside the canvas, contents per state (§5). Primary workspace: the conversation,
plus diff, cost, and the create-child affordance.

---

## 8. Data model

Sketch, not final.

**project** — `id`, `name`, `description`, `repo_path`, `default_model`,
`default_permission_mode`, `created_at`

**node** — `id`, `project_id`, `parent_id`, `display_name`, `description`,
`session_id`, `branch_name` (nullable), `base_commit`, `head_commit` (nullable),
`worktree_path`, `creates_branch`, `writable`, `status`, `model` (nullable
override), `permission_mode` (nullable override), `position_x`/`position_y`
(nullable), `created_at`

**run** — `id`, `node_id`, `status`, `started_at`, `ended_at`, `input_tokens`,
`output_tokens`, `cost`, `error`

Cost is captured per run from the SDK result message from day one (D20).

---

## 9. Architecture

Local backend process serving a browser UI on localhost; wrappable in
Electron/Tauri later. TypeScript end to end — it wraps into a desktop shell with
no sidecar-binary pain and shares a language with the UI (D13, D14a).

### Five structural constraints

These are the things that are expensive to retrofit. Everything visual is cheap
to change; these are not.

1. **Runs are async jobs.** Start returns a job ID, progress streams (SSE or
   websocket), cancellation exists. Nothing blocks the UI. This is what makes a
   tree of parallel experiments possible at all.
2. **Selection is a list, not a single node.** V0 only ever uses the first
   element, but compare-mode (B8) otherwise touches every component later.
3. **The backend is the source of truth for the tree.** The UI renders what the
   server says; it never mutates a local tree and hopes they match.
4. **Render from flags, not types.** Branch on `creates_branch` / `writable`,
   never on a node "type" string.
5. **Nothing touching git, the filesystem, or the agent lives in UI code.** One
   API surface, no exceptions.

Plus: state in SQLite in an app data directory, never browser storage. Node
positions nullable, auto-layout by default. Repo path is config. Agent invocation
sits behind one interface (D14c/d/e).

---

## 10. Agent integration

Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) — the same harness as Claude
Code, so file editing, search, and bash are already reliable (D15).

- **Inheritance is session forking**:
  `query({ resume: parentSessionId, forkSession: true, cwd: nodeWorktree })`.
  Full ancestor history, parent untouched, siblings invisible. Forking only
  branches from a session's latest state — harmless, since nodes freeze at their
  tip (D16).
- **`cwd` per node is the isolation boundary.** Every node has one, including
  exploration nodes (detached worktree), so the runner has no special cases (D17).
- **`allowedTools`** restricted to read-only for exploration and frozen nodes
  (D18).
- **Hooks block mutating git** — commit, branch, checkout, merge, reset. Read-only
  git (`status`, `diff`, `log`) is allowed and needed for recovery (D30).
- **Model and permission mode** are settings: project default, per-node override
  (D32).
- Session files are machine-local. Fine for a local app.
- Packaging: the SDK runs Claude Code in a subprocess and ships a native binary
  per platform — plan for bundling when going desktop.
- Auth supports both an API key and subscription login (D23).

---

## 11. Known costs of these choices

- **Fork depth costs tokens.** A fork at depth 6 replays everything above it.
  Accepted for V0; B7 (ancestor diffs + summaries) is the optimization.
- **Branches accumulate forever.** No merge, no pruning. Accepted (B5).
- **Delete is destructive.** Runs cost money and are not reproducible — the same
  prompt does not regenerate the same code. Soft delete is B9.

---

## 12. Open questions

Carried from the decision log; none block starting.

1. Does master get its own worktree, or use the repo's main checkout?
2. Is there a cap on concurrent runs?
3. What happens if a node is deleted while running?
4. When are exploration worktrees cleaned up?
5. Which auth path is the default when both are configured?
