Bonsai — project rules
Bonsai is a local tool where each node on a mindmap is an AI agent session bound
to a git branch. Full spec in docs/v0-prd.md; decision log and deferred backlog
in docs/v0-decisions-and-backlog.md.
Scope
The demo script in PRD §2 is the definition of done. If a change isn't needed by
that script, it doesn't belong in V0.
Do not build, and do not build toward: merging, syncing with the user's own
copy, importing existing repos, comparing nodes side by side, editing nodes that
have children, conflict resolution, pruning/archiving/search, multi-user or
hosting.
These are tracked as B1–B13 and are deferred on purpose, not forgotten.
Non-negotiable constraints
Runs are async jobs. Start returns a job ID, progress streams, cancel
works. Nothing blocks the UI.
Selection is a list, even though V0 only uses the first element.
The backend owns the tree. The UI renders server state; it never mutates a
local tree optimistically.
Render from flags (creates_branch, writable), never from a node "type"
string.
No git, filesystem, or agent access in UI code. One API surface.
Plus: SQLite in an app data dir, never browser storage. Node positions nullable,
auto-layout by default. Repo path is config. Agent invocation behind one
interface.
Domain rules that are easy to get wrong
A node's git base is the nearest ancestor with a commit, not its parent.
Exploration nodes have no commits, so the walk can be several hops.
Nodes are immutable. Never amend a commit. Never rewrite history. New
commits only.
A node may hold several commits while it's a leaf. A node is a branch, not a
single commit.
A node freezes when it gets a child — writable only while it's a leaf.
The app owns git; the agent does not. The agent may run read-only git
(status, diff, log) but never commit, branch, checkout, merge, or reset.
The agent writes CONTEXT.md; the app commits.
Branch names are node/<uuid> — generated once, never shown, never renamed.
Display names are metadata and change freely.
git diff misses untracked files. Use git status --porcelain alongside
it, or git add -A first. This matters for interrupted-run recovery.
Working style
Ask before adding dependencies.
Ask when the spec is ambiguous rather than picking a plausible reading. The
ambiguities in this design were hunted deliberately; a new one is probably real.
Small commits, one concern each.