-- Bonsai schema. PRD §8 is a sketch, not final; the deltas from it are
-- deliberate and are explained inline.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  -- D14e: repo path is config, never hardcoded.
  repo_path               TEXT NOT NULL,
  default_model           TEXT,
  -- Non-interactive until the ask-user mechanism lands: with no needs_you
  -- there is nobody to answer a permission prompt, and a run would stall with
  -- no timeout and no visible cause.
  default_permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
  -- D32: reasoning effort, alongside model, as a project-level setting. The
  -- single biggest lever on what a run costs after the model itself.
  default_effort          TEXT,
  -- 'created' = Bonsai made the repository and owns it outright.
  -- 'adopted' = the user pointed Bonsai at a directory they already had.
  -- The difference decides what deleting a project is allowed to remove.
  source_kind             TEXT NOT NULL DEFAULT 'created',
  -- The project's working folder: master's checkout. Whose it is depends on
  -- source_kind -- Bonsai's when created, and the user's, never deleted, when
  -- adopted. Null only for projects made before this column existed.
  source_path             TEXT,
  -- The branch that was already checked out when the project was adopted.
  -- Bonsai must never delete it: it is the user's own branch, not a node/<uuid>.
  protected_branch        TEXT,
  created_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  -- D7: delete cascades to descendants.
  parent_id     TEXT REFERENCES node(id) ON DELETE CASCADE,
  -- D33: display name is renameable metadata and never touches git.
  display_name  TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',

  session_id    TEXT,
  -- A3: forks are snapshots. A frozen node stays conversational, so two
  -- children of one parent can inherit different amounts of its conversation.
  -- Recording where each fork was taken is what lets the panel say so.
  forked_from_message_seq INTEGER,

  -- Emergent model: the branch is just a ref, so it is deferred. A node's
  -- worktree starts detached at base_commit and a branch is created only if
  -- the run actually changed files. Both stay null for a node that changed
  -- nothing -- which is exactly the case the lineage walk passes through.
  branch_name   TEXT,
  -- Pinned at creation by resolveBaseCommit(). Immutable. Null for master
  -- alone, which is never a child. See the termination invariant in lineage.ts.
  base_commit   TEXT,
  head_commit   TEXT,

  worktree_path TEXT NOT NULL,
  status        TEXT NOT NULL,
  model           TEXT,
  permission_mode TEXT,
  -- Nullable, auto-layout by default (PRD §9).
  position_x    REAL,
  position_y    REAL,
  created_at    TEXT NOT NULL,

  CHECK (status IN ('new', 'running', 'needs_you', 'ready', 'interrupted')),
  -- The termination invariant, enforced in SQL: every non-root node carries a
  -- pinned base.
  CHECK (parent_id IS NULL OR base_commit IS NOT NULL),
  -- A node with a commit must have the branch that commit landed on.
  CHECK (head_commit IS NULL OR branch_name IS NOT NULL)
);

-- creates_branch and writable are NOT columns. Both are derived on every read
-- (domain/flags.ts) so they cannot drift out of step with the tree:
--   creates_branch = head_commit IS NOT NULL
--   writable       = no child of this node has a head_commit
-- PRD §8 lists them as fields; storing a derived fact that changes when *another
-- row* changes is a bug waiting to happen, so they live in NodeView instead.

CREATE INDEX IF NOT EXISTS node_project_idx ON node(project_id);
CREATE INDEX IF NOT EXISTS node_parent_idx  ON node(parent_id);

CREATE TABLE IF NOT EXISTS run (
  id            TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  status        TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- D20: captured from the SDK result message from day one.
  --
  -- An ESTIMATE at list price, which the SDK is explicit about: it is not a
  -- billing statement. On a subscription login nothing is billed per token at
  -- all, so this says what the tokens would have cost through the API.
  cost          REAL NOT NULL DEFAULT 0,
  -- Which model actually ran. Not knowing this made "why did that cost so
  -- much?" unanswerable, since Bonsai sets no model and inherits the SDK's
  -- default unless a project or node overrides it (D32).
  model         TEXT,
  -- Broken out because fork depth is the thing that grows cost here: a child
  -- replays its whole ancestor chain (PRD §11), and whether those tokens were
  -- cache reads or fresh input is most of the difference in what it costs.
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  -- Which credential paid for this run. 'none' means a claude.ai subscription
  -- login, where nothing is charged per token and the cost above is an
  -- API-equivalent figure rather than money that moved.
  api_key_source        TEXT,
  -- The commit this run produced, or null when it changed nothing. Lets the
  -- conversation show the diff for each exchange in place, rather than only a
  -- single whole-node diff detached from the message that caused it.
  commit_sha            TEXT,
  -- D31: a failed run is an `interrupted` node plus this. `failed` is not a
  -- sixth node state.
  error         TEXT,
  CHECK (status IN ('running', 'done', 'cancelled', 'failed'))
);

CREATE INDEX IF NOT EXISTS run_node_idx ON run(node_id);

-- Not in PRD §8. §5 requires a transcript for `ready` and `interrupted` nodes
-- across app restarts and there was nowhere to put one. Re-reading the SDK's
-- machine-local session JSONL would put an agent-internal file format in the
-- read path of the UI.
CREATE TABLE IF NOT EXISTS message (
  id           TEXT PRIMARY KEY,
  node_id      TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  run_id       TEXT REFERENCES run(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (node_id, seq),
  CHECK (role IN ('user', 'assistant', 'system')),
  CHECK (kind IN ('text', 'tool_use', 'tool_result', 'result'))
);

-- Also not in PRD §8. The mechanism behind needs_you is postponed, but §7
-- requires the canvas card to show the agent's question as its summary line,
-- which needs structured text. Schema now so it does not need rebuilding.
CREATE TABLE IF NOT EXISTS question (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  answer      TEXT,
  asked_at    TEXT NOT NULL,
  answered_at TEXT
);

CREATE INDEX IF NOT EXISTS question_node_idx ON question(node_id);
