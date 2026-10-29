# Storage, backups, and recovery

## What Bonsai stores

Each project has one shared working folder. Git keeps saved code versions; SQLite keeps
experiments, conversations, sessions, and run history. Each experiment also retains its
own local files where necessary.

Git objects are shared; the active checkout contains a full working copy of tracked files,
not just files the experiment changed. Inactive experiments do not each need another checkout.

Dependencies, generated files, preserved outputs, Git history, backups, and recovery copies
can all consume space. **Settings → Storage** separates these categories.

## Rebuildable folders

In **Settings → Project**:

1. Set a setup command that can prepare the project.
2. Add **Regeneratable folders**, one repository-relative path per line, such as
   `node_modules`, `.venv`, or `.next`.

Only explicitly declared, Git-ignored folders are disposable. Do not list valuable outputs
or files you cannot rebuild. Paths are literal; wildcard patterns are not accepted.

Switching experiments removes declared rebuildable artifacts. The next writable run reruns
setup. Continuing the same active experiment normally reuses its prepared environment.
Read-only runs skip setup.

Other ignored files are moved into private storage for the outgoing experiment and restored
when it becomes active again. Dependencies that are not declared regeneratable are preserved
too, so disk use can remain large. Bonsai does not share installed environments between nodes.

## Free working space

Use **Free working space** from the active experiment's menu.
It releases the checkout while keeping saved code, conversations, and preserved local files.
The next run recreates the workspace.

Bonsai blocks cleanup while the workspace is busy, held, dirty, or has unexpected Git state.
Automatic idle cleanup uses the same checks.

Deleting an experiment removes its saved Bonsai records and owned files.
Freeing working space does not delete the experiment.

## Convert an existing project

Projects created before shared checkout retain their separate experiment folders.

1. Make a verified backup and stop the project's jobs.
2. Save/import unfinished changes, or deliberately discard them.
3. Configure setup and regeneratable folders in **Settings → Project**.
4. Choose **Review conversion**, resolve blockers, then **Convert workspace**.

Conversion verifies saved code and ownership, preserves unclassified ignored files, and
removes old managed checkouts. Interrupted conversion offers **Resume conversion**.
There is no automatic rollback. Until conversion, the project keeps its previous archive
behavior, including the ignored-file warning.

## Back up and restore

Choose **Settings → Storage → Make backup** after stopping active work.
Bonsai verifies an independent copy of the database, Git history, working and staged files,
ignored files, saved conversations, comparison snapshots, and retained recovery data.
Backups exclude authentication credentials and arbitrary Git credential/remote/hook settings.

Copy the completed backup to another disk. A backup with `complete: false` is incomplete.

To restore:

1. Close Bonsai and preserve the current data folder.
2. Put the **whole completed backup** in the chosen data location.
3. Point `BONSAI_DATA_DIR` at it if using a nondefault location.
4. Start a compatible Bonsai build and sign in again.

Bonsai repairs verified owned paths on startup. Do not use a live filesystem copy as a
consistent backup, or restore only SQLite while leaving changed repositories in place.
An older executable needs a suitable pre-upgrade backup, not a schema-number edit.

## Recover unfinished or external changes

After a crash, review the interrupted experiment and use its explicit recovery actions.
Unfinished edits, locks, unexpected commits, or changed repository identity block switching.

For interrupted preparation, Project settings offers **Retry preparation** or
**Preserve files and restore**. Preservation verifies independent copies of staged,
working, ignored, and saved code before restoring the recorded experiment.
Bonsai does not silently stash, reset, or import outside changes.

Stop external previews before releasing Keep active. Bonsai cannot detect every external
program, and process cleanup after a crash is best effort, particularly on Windows.

## Move storage

For moving an installation, restore a verified backup at the new location.
Use **Locate repository** when an external repository has moved; Bonsai verifies its identity
rather than guessing a replacement. Changing the default storage setting affects future
locations; it does not move every existing project.
