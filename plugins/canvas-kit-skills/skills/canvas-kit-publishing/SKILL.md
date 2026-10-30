---
name: canvas-kit-publishing
description: "Publish canvases and other Copilot plugins as a marketplace with @rwoll/canvas-kit and GitHub Actions, and update installs. Use when setting up publishing, adding content-only plugins (skills, agents, MCP servers), releasing a change, or installing a canvas-kit marketplace."
---

# Publish a canvas marketplace

A canvas-kit marketplace repository builds every plugin on `main` and publishes
the installable result to a `stable` branch.

```text
marketplace.config.json         name, owner, repository, publishBranch, sourceBranch
plugins/<name>/                 content-only plugins: plugin.json + skills/, agents/, ...
canvases/<name>/                canvases; package.json name/version/description become the manifest
.github/workflows/publish.yml   publishes stable on every push to main
.github/workflows/check.yml     checks pull requests with a read-only token, and actions.lock
.github/workflows/actions.lock  the commit every action runs at (gh actions-lock)
.github/dependabot.yml          weekly updates after a 7-day cooldown
```

## Publish on every push

```yaml
# .github/workflows/publish.yml (written by canvas-kit init)
name: Publish marketplace
on:
  push:
    branches: [main]
permissions: {}
jobs:
  publish:
    permissions:
      contents: write
    uses: rwoll/canvas-kit/.github/workflows/marketplace.yml@<commit> # v0.1.0
    with:
      playwright: true          # only if the check runs browser tests
      environment: stable       # optional: approve each publish
```

A **build** job with a read-only token installs with a frozen lockfile and runs
the `check` script (or `build`) in a clean worktree. When `dist/marketplace`
changed, it prepares the next `stable` commit, with a `release.json` stamp per
changed plugin that the canvas footer shows. A **push** job that runs none of the
project's code checks that commit and fast-forwards `stable`. To check without
pushing, pass `dry-run: true`.

Keep it safe:

- Pin `uses:` to a full commit SHA, never `@main`; Dependabot updates the pin.
- Lock the actions: after `canvas-kit init`, and after any change to a `uses:`,
  run `gh actions-lock` (install it with
  `gh extension install github/gh-actions-lock`) and commit
  `.github/workflows/actions.lock` with the workflows. Never pass
  `--accept-moved` without asking the user why an upstream commit moved.
- Never add `pull_request_target`, or pass secrets or write tokens to jobs that
  run pull request code.
- To approve each publish, create a `stable` environment with required reviewers
  (public repositories, or GitHub Enterprise), limited to `main`, and pass
  `environment: stable`.

`marketplace.config.json` can override the commands: `checkCommand` (for example
`"pnpm check && pnpm e2e"`), `installCommand`, and `buildCommand`.

## Add a content-only plugin

```text
plugins/my-skills/plugin.json            {"name": "my-skills", "version": "0.1.0", "description": "..."}
plugins/my-skills/skills/<skill>/SKILL.md
```

The folder name must match `name`. Plugin names are unique across `plugins/` and
`canvases/`.

## Release a change

1. Bump `version` in the changed plugin's `plugin.json`, or in the canvas's
   `package.json`, for every user-visible change.
2. `pnpm check`, commit, and push to `main`.
3. The workflow publishes it. Locally, `pnpm exec canvas-kit release --dry-run`
   shows what would be published.

## Install and update

```sh
copilot plugin marketplace add <owner>/<repo>#stable
copilot plugin install <plugin>@<marketplace name>
copilot plugin marketplace update <marketplace name> && copilot plugin update --all
```

After installing or updating a canvas, reload extensions. If the canvas footer
still shows the old version, reload again. A chat does not see a plugin installed
after it started; use a new chat.
