# Bonsai

In Bonsai, a tree becomes itself through the branches you choose to keep. Every idea gets its own
branch, and you decide which ones grow. Bonsai turns AI coding sessions into a visual tree of
experiments; each branch its own agent, its own code, its own conversation.

Each node on the mindmap is one agent session bound to a git branch. A node forks two independent
things from its parent: **code** (a git branch, taken from the nearest ancestor that actually has a
commit) and **conversation** (a session fork, taken from the direct parent). Those two lineages are
allowed to diverge, and that divergence is the point.

Full spec in [`docs/v0-prd.md`](docs/v0-prd.md); decisions and deferred backlog in
[`docs/v0-decisions-and-backlog.md`](docs/v0-decisions-and-backlog.md).

---

## Status: V0 complete

Built in milestones, each with a review checkpoint.

| | | |
|---|---|---|
| M1 | Skeleton — schema, API, canvas | done |
| M2 | Git layer — repos, worktrees, the ancestor-commit walk | done |
| M3 | Agent layer — Claude Agent SDK, session forking, cancellation | done |
| M4 | Lifecycle — node states, `CONTEXT.md`, interrupted-run recovery | done |
| **M5** | Detached worktrees and the full demo script | **done** |

**The demo script in PRD §2 runs end to end**, which is V0's definition of done:
a project scaffolded from its description, two approaches branched from master,
a question asked about one of them, and a child of that question which carries
its whole conversation while branching from the commit *above* it. Five nodes,
correct ancestry, siblings isolated.

The side panel is a chat: message a node, read the reply, expand the diff each
exchange produced, reply again. Drag from a node's `+` handle into empty canvas
to create a child where you dropped it. If the app dies mid-run, the node comes
back `interrupted` with its partial work intact, and resume tells the agent what
actually landed rather than letting it guess. Routes whose milestone has not arrived
return `501` naming the milestone rather than silently doing nothing.

### Two ways to start a project

**New project** builds a fresh repository in a folder you pick. Bonsai owns all
of it, including deleting it when you delete the project.

**Use an existing folder** points Bonsai at a directory you already have, and
uses it *where it is* — nothing is copied and nothing is moved. That folder
becomes the project's repository, master is that folder on the branch it is
already on, and each node you create is an ordinary `node/<uuid>` branch inside
your own repo with its own worktree elsewhere. So the work a node does is
reachable with your normal git:

```bash
git branch                 # your branches, plus one per node that committed
git switch node/<uuid>     # or diff it, cherry-pick it, whatever you like
```

That is also why there is no export feature: the output was never anywhere else.

Two consequences worth knowing before you use it:

- **Master is read-only.** Its worktree is your checkout, on the branch you work
  on yourself, so Bonsai reads it and answers questions about it but never
  writes or commits there. To change anything, drag out a child.
- **Your existing branches do not become nodes**, deliberately. Git branches form
  a DAG rather than a tree, git does not record which branch was forked from
  which, and decisively an imported branch carries no conversation — a node
  without one is an empty shell that gives its children nothing.

Deleting a project you adopted removes the nodes, their worktrees and the
`node/<uuid>` branches Bonsai created. Your folder, your history and your branch
are left exactly as they were, and the confirmation says so by name.

### Trying it

Create a project, then create children from the side panel. Nothing asks you
which kind of node you are making — a node that changes files gets a branch and
a commit, and a node that only answers a question does not.

Talk to a node in the panel — it is a conversation, not a single request, so
the agent can ask for detail and you can answer. Each reply that changes files
adds a commit to that node and shows its diff inline.

Ask a question under a node, then create a child of that question. The child
inherits the question's whole conversation, but its code branches from the
question's *parent* commit, because the question never made one. That divergence
between code lineage and conversation lineage is what the product is built
around, and it is the thing to look at first.

With the stand-in agent (no credentials), one convention decides which a node
becomes: a prompt starting with `?` writes nothing, anything else writes a file.
With a real agent, what the agent actually did decides it.

---

## Running it

### Prerequisites

- **Node.js 22.5 or newer.** Nothing else. Bonsai uses the built-in `node:sqlite` and `node:test`,
  so there is no native module to compile and no test runner to install.
- Check with `node --version`.

### Connecting to Claude

Bonsai uses the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).
Either credential works (D23), and both are set up **inside the app**:

- **A Claude subscription.** Sign in from the connection screen, or run
  `claude auth login` yourself. Bonsai never sees or stores this credential.
- **An API key.** Paste it into Settings. Stored on your machine only, in a file
  readable just by you, and never sent to the UI once saved.

Bonsai establishes the connection **by making a real request**, not by looking
for credential files. That matters on macOS, where a subscription login lives in
the Keychain and is invisible on disk — a filesystem check reports "no
credentials" for someone who is perfectly well signed in.

**Without a working credential Bonsai stops.** No project creation, no runs, no
chat. It used to fall back to a stand-in agent that wrote placeholder files,
which was right for reviewing the code and wrong for using it: the app looked
like it worked while quietly doing something else. The stand-in is now opt-in
via `BONSAI_FAKE_AGENT=1`, and exists for tests.

**Real runs cost real money.** Each node forks its parent's conversation, so a
node at depth 6 replays everything above it (PRD §11 accepts this for V0; B7 is
the optimization). Model, effort, tokens and estimated cost are all shown per
node, and Settings has the two levers that matter.

Model, effort, permission mode and folder locations all live in **Settings**;
these variables are for tests and unusual setups.

| Variable | Effect |
|---|---|
| `BONSAI_FAKE_AGENT=1` | Use the stand-in agent. Output is fake; for tests. |
| `BONSAI_PORT` | Port to serve on. Default 8787, loopback only. |
| `BONSAI_DATA_DIR` | Where the database and settings live. |

### What a run costs, and how to spend less

**Settings** holds the **model** and the **effort**, and the menu bar shows the
estimated total across every run in the project. Both are changeable at any time
and apply to the next run.

Expect roughly **$0.05–0.15 per run on Opus at default effort**, most of which
is fixed overhead rather than your prompt: the Claude Code system prompt and
tool definitions are resent on every turn, and a small change is several turns.

Three levers, largest first:

1. **Model.** Haiku 4.5 is $1/$5 per Mtok against Opus 5's $5/$25 — roughly five
   times cheaper for the same shape of work.
2. **Effort.** `low` or `medium` cuts thinking tokens and produces fewer,
   more-consolidated tool calls. Often the better first move on small changes.
3. **Depth.** Every node replays its whole ancestor conversation, so cost grows
   as the tree deepens (PRD §11 accepts this for V0; B7 is the fix). Branching
   wide from a shallow node is cheaper than chaining deep.

The panel breaks out **cache-read tokens** per node. A high number there next to
a high cost means the replay is being served from cache and is already cheap; a
low one means it is not.

### Install and run

```bash
git clone https://github.com/MhmdAlTamimi/Bonsai.git
cd Bonsai
npm install
npm start
```

`npm start` builds both halves, serves them on one port, and opens your browser.
Bonsai binds to `127.0.0.1` only — it runs an agent with file-editing permission
and has no authentication, so it is never reachable from the network.

The first screen asks you to connect to Claude. Nothing else works until you do.

For UI work there is a hot-reloading dev server: `npm run dev` in one terminal
and `npm run dev:ui` in another, then open http://localhost:5173.

### Tests

```bash
npm test
```

89 tests, no network and no agent — they run the same with or without
credentials, and never spend anything. The last of them is the §2 demo script
itself, run against real git from project creation to the five-node tree. Roughly half are pure unit tests over
`domain/lineage.ts` — the nearest-ancestor-commit walk. The rest are integration
tests that run **real git** in temporary directories, including the M2
checkpoint: a node whose parent has no commits of its own branches from the
correct grandparent commit, verified in the commit graph rather than only in the
database. Session forking is covered by a recording runner: which session a
run inherits, and whether it forks, is decided by the pipeline rather than by
the SDK, so it is provable without credentials.

### Configuration

All optional; every one has a working default.

| Variable | Default | Meaning |
|---|---|---|
| `BONSAI_PORT` | `8787` | Backend port. |
| `BONSAI_DATA_DIR` | OS app-data dir | Where `bonsai.db` lives. |
| `BONSAI_REPOS_ROOT` | `<data dir>/repos` | Where per-project bare repos and worktrees will live (M2). |
| `BONSAI_MODEL` | unset | Default model for new projects (M3). |
| `BONSAI_SEED` | unset | `1` seeds a fake demo tree with no git behind it. Not needed. |

The database is created and seeded on first run. To start over, delete it:

```bash
rm -rf "$BONSAI_DATA_DIR"        # or the printed path from the server's startup line
```

The server prints its data directory on startup, so you always know what to delete.

---

## Layout

```
packages/shared    the API contract, imported by both sides and by nothing else
packages/server    HTTP, SQLite, git, and the pure domain logic
  src/domain       lineage, flags, lifecycle — no git, no db, no agent, no io
  src/db           schema and the typed store
  src/git          the only code that shells out to git
  src/agent        the runner interface, and the M2 stand-in behind it
  src/jobs         async run jobs: start, stream, cancel
  src/api          routes and the SSE bus
packages/ui        React + React Flow canvas and side panel
```

`shared` is the only module both sides import, which is how "nothing touching git, the filesystem,
or the agent lives in UI code" (PRD §9) is enforced by the module graph instead of by discipline.
`NodeView` deliberately carries no branch names, worktree paths, session ids or commit shas — the UI
cannot misuse a path it was never given.

## Contributing

- **Ask before adding a dependency.** The dependency list is short on purpose: `react`, `react-dom`,
  `reactflow` and `dagre` for the canvas, `vite` and `typescript` to build. Everything else is a Node
  built-in.
- **Small commits, one concern each.**
- **Ask when the spec is ambiguous** rather than picking a plausible reading. The ambiguities in this
  design were hunted deliberately; a new one is probably real.
- The demo script in PRD §2 is the definition of done. If a change isn't needed by that script, it
  doesn't belong in V0. PRD §3 lists the non-goals by name.

## Licence

MIT. See [LICENSE](LICENSE).
