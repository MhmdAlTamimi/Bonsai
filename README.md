# Bonsai

Bonsai is a local app for exploring coding ideas with Claude. Create experiments on a visual
tree, continue each conversation independently, and compare the resulting code before
applying it to your project.

## Install

Requires **Node.js 22.18+**, npm, and Git.

```bash
git clone https://github.com/MhmdAlTamimi/Bonsai.git
cd Bonsai
npm ci
npm start
```

Bonsai builds the app and opens [localhost:8787](http://localhost:8787).
Connect your Claude subscription or API key in Settings.

## Get started

1. Create a project or choose an existing folder.
2. Create a child experiment from the version you want to explore.
3. Describe the change. Optionally add checks and the desired output.
4. Review the changes, compare experiments, and use **Apply to your repo** to export a patch.

Each project uses one working folder. Running an experiment loads its saved code there;
reading conversations and reviewing changes does not switch it. Experiments in the same
project run one at a time. Different projects can run concurrently.

**Open folder** activates an experiment and enables **Keep active**, which protects it while
you use an editor or preview. Stop the preview and release Keep active before running a
different experiment.

## Storage and upgrades

Use **Settings → Storage → Make backup** before upgrading an existing installation.
Older projects keep their separate experiment folders until you convert them in
**Settings → Project → Review conversion**.

Declare rebuildable folders such as `node_modules` or `.venv` in Project settings and provide
a setup command. Other ignored files are preserved, so they can still take disk space.
**Free working space** removes the current working folder while keeping saved experiments.

Agents and setup commands run with your account's filesystem access. Worktrees do not
provide a security sandbox. Keep the local server private.

## Guides

- [Installation and updates](docs/installation.md)
- [Using Bonsai](docs/usage.md)
- [Storage, backups, and recovery](docs/storage.md)
- [Development](docs/development.md)
