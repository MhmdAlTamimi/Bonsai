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

## Status: M1 (skeleton)

Built in milestones, each with a review checkpoint.

| | | |
|---|---|---|
| **M1** | Skeleton — schema, API, canvas | **done** |
| M2 | Git layer — repos, worktrees, the ancestor-commit walk | next |
| M3 | Agent layer — Claude Agent SDK, streaming, cancellation | |
| M4 | Lifecycle — node states, `CONTEXT.md`, interrupted-run recovery | |
| M5 | Detached worktrees and the full demo script | |

**M1 has no git and no agent.** The canvas renders a seeded five-node tree from SQLite so the data
model and the API surface can be reviewed before either lands. Routes whose milestone has not
arrived return `501` naming the milestone rather than silently doing nothing.

---

## Running it

### Prerequisites

- **Node.js 22.5 or newer.** Nothing else. Bonsai uses the built-in `node:sqlite` and `node:test`,
  so there is no native module to compile and no test runner to install.
- Check with `node --version`.

### No API key is needed yet

M1 does not talk to Anthropic at all — there is no agent layer to talk to it. You need **no
credentials, no `.env`, and no account** to run and review M1.

That changes at **M3**, when the Claude Agent SDK lands. From then on you will need one of:

- `ANTHROPIC_API_KEY` in the environment, or
- a Claude subscription login through the Claude Code CLI (D23 supports both).

M3 will document the exact setup when it adds the dependency. Until then, running Bonsai costs
nothing and calls nothing.

### Install and run

```bash
git clone https://github.com/MhmdAlTamimi/Bonsai.git
cd Bonsai
npm install
```

Two processes during development. In one terminal:

```bash
npm run dev          # builds the backend and serves it on http://localhost:8787
```

In another:

```bash
npm run dev:ui       # vite dev server on http://localhost:5173, proxying /api to 8787
```

Then open **http://localhost:5173**. You should see five nodes with the panel opening on select.

To run it as a single process instead, build the UI once and let the backend serve it:

```bash
npm -w @bonsai/ui run build
npm run dev          # now also serves the UI at http://localhost:8787
```

### Tests

```bash
npm test
```

31 tests, no network, no git, no agent. The bulk of them cover `domain/lineage.ts` — the
nearest-ancestor-commit walk, which is the subtlest logic in the product and is deliberately pure so
it can be tested without agent latency or cost.

### Configuration

All optional; every one has a working default.

| Variable | Default | Meaning |
|---|---|---|
| `BONSAI_PORT` | `8787` | Backend port. |
| `BONSAI_DATA_DIR` | OS app-data dir | Where `bonsai.db` lives. |
| `BONSAI_REPOS_ROOT` | `<data dir>/repos` | Where per-project bare repos and worktrees will live (M2). |
| `BONSAI_MODEL` | unset | Default model for new projects (M3). |

The database is created and seeded on first run. To start over, delete it:

```bash
rm -rf "$BONSAI_DATA_DIR"        # or the printed path from the server's startup line
```

The server prints its data directory on startup, so you always know what to delete.

---

## Layout

```
packages/shared    the API contract, imported by both sides and by nothing else
packages/server    HTTP, SQLite, and the pure domain logic
  src/domain       lineage, flags, lifecycle — no git, no db, no agent, no io
  src/db           schema and the typed store
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
