# Installation and updates

## Requirements

- Node.js **22.18 or newer**, npm, and Git on PATH.
- A supported Claude Agent SDK runtime and access through a Claude subscription or API key.
- A browser. Chrome or Chromium is needed only for browser tests.

CI checks Node 22 on Linux and Windows. Process-tree discovery is implemented on Linux and
macOS; Windows cannot reliably discover every background process left by an agent.

## Install and start

```bash
git clone https://github.com/MhmdAlTamimi/Bonsai.git
cd Bonsai
npm ci
npm start
```

These commands also work in PowerShell. Start Bonsai from the repository's root.
`npm start` builds the server and interface, serves them at
[localhost:8787](http://localhost:8787), and opens your browser.
If a browser does not open automatically, use that address.

Open Settings to connect Claude. Subscription sign-in uses Claude Code bundled with the
Agent SDK; a separate global Claude Code installation is unnecessary.
API keys are stored in the local settings file with restricted permissions.
Connection checks contact Claude. Without a connection you can still review saved work.

## Update

1. Make a backup in **Settings → Storage** and copy the completed backup elsewhere.
2. Stop Bonsai.
3. Update and restart:

```bash
git switch main
git pull --ff-only
npm ci
npm start
```

If Git reports local changes or a diverged branch, preserve that work before continuing.
`--ff-only` updates your checkout only when Git can advance it without creating a merge.

New projects use one shared checkout. Existing projects retain separate experiment folders
until you explicitly [convert them](storage.md#convert-an-existing-project).

## Database compatibility

The shared-checkout build uses database schema **29**. Older builds, including schema-20 and
schema-28 builds, cannot open that data. Switching a Git branch does not switch or downgrade
the database.

If you see `DatabaseTooNewError`, run the current `main` build against the upgraded data.
To run an older build, use a separate data folder or a suitable complete pre-upgrade backup.
Do not lower the schema number or replace only the database after workspaces have changed.

## Data locations

| System | Default data folder |
| --- | --- |
| Linux | `~/.local/share/bonsai`, or `$XDG_DATA_HOME/bonsai` |
| macOS | `~/Library/Application Support/Bonsai` |
| Windows | `%LOCALAPPDATA%\Bonsai` |

The startup message and **Settings → Diagnostics** show the active paths.
Managed repositories default to `<data folder>/repos`; project folders can have their own
recorded locations.

For a separate test installation, set **both** `BONSAI_DATA_DIR` and `BONSAI_REPOS_ROOT` to
new locations before starting it. Use another `BONSAI_PORT` if both installations run at
once. Do not point the test installation at a copy of live data with unchanged absolute
workspace paths; use a verified independent backup when testing existing projects.

See [storage and recovery](storage.md) for backup and restore instructions, and
[development](development.md#configuration) for environment variables.
