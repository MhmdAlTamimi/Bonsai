# Using Bonsai

## Start a project

Choose **Start fresh** to create a project, or select an existing folder.
For a Git repository, choose the version to start from. Including unsaved changes snapshots
eligible files without changing your original checkout or index.

An adopted project's root experiment is a read-only snapshot. Create a child to make changes.
If the original repository changes later, existing Bonsai experiments keep their saved code.

For projects that need dependencies, set a setup command in **Settings → Project**.
Examples include `npm ci` or a command that creates and installs a Python environment.
Set only paths you can rebuild as **Regeneratable folders**.

## Create and run an experiment

Create a child from the experiment you want to branch from. Give it a name and request;
the check instructions and desired output are optional.

**Enter** adds a newline to the request. **Ctrl/Cmd+Enter** creates and starts the experiment.
You can also save it for later.

A child starts from its parent's code as saved when the child is created. By default it
also inherits the conversation up to that point. **Start fresh** starts a new conversation.
Later changes to either experiment do not flow into the other automatically.

Send another message to continue an experiment. Questions and permission requests appear
in its conversation. Stop preserves unfinished work; use the recovery actions before
switching experiments. Finish now ends background waiting and saves under the normal run
completion rules; it does not confirm that unfinished tests passed.

## Understand the workspace

A project has one working folder:

- **Active workspace:** this experiment's code is currently loaded in that folder.
- **Saved experiment:** its code and conversation are saved; it does not need a live folder.
- **Keep active:** holds the folder on the current experiment for external editing or a preview.

Running an experiment or choosing **Open folder** activates its code. Open folder also enables
Keep active. Reading a conversation, Review, Apply, or Compare does not activate code.

Stop external previews and release Keep active before another experiment uses the folder.
Unfinished edits or unexpected Git changes block switching and offer explicit recovery.
Runs in the same project queue, including while an agent waits for your answer.

## Review and apply

Open **Review** to inspect the experiment's changes.
**Whole line** includes its ancestors' changes since the line left the root snapshot.

Choose **Apply to your repo** to export a patch and get the command to apply it.
Bonsai does not merge into your original repository. Applying the patch leaves changes for
you to review, test, and commit.

## Compare and share context

Select two to four experiments with **Compare** or Ctrl/Cmd/Shift-click their cards.
Comparison answers use saved snapshots and cannot edit or run experiment code.
Use **Update** to refresh a comparison after an experiment changes.

Type `@` in a message to attach a project reference or another experiment.
References hold reusable text. An experiment mention supplies a snapshot of its saved work;
it does not merge its code or conversation.

Use `/compact` to shorten an experiment's conversation context.
The saved conversation stays reviewable.

## Manage disk space

Use **Free working space** from the active experiment's menu to release its checkout.
Saved code and conversations remain available. Older, unconverted projects use **Archive folder**.

See [storage, backups, and recovery](storage.md) for conversion, ignored files, and recovery.
