# Contributing

Requires Node.js 22.12+ and pnpm 11, pinned by `packageManager`.

```sh
pnpm install
pnpm check                          # build, typecheck, lint, unit tests
pnpm playwright:install            # once: Playwright's Chromium
pnpm e2e                            # browser tests
pnpm dev                            # every canvas in a browser, live
pnpm consumer-test                  # pack the packages and use them from a new marketplace
pnpm new-canvas <name>              # add an example canvas
```

## Layout

This repository is a canvas-kit marketplace, and its root is a canvas project, as
`canvas-kit init` creates. It also holds the packages, as a pnpm workspace:

```text
marketplace.config.json        the marketplace, published to the stable branch
vite.config.ts                 builds the canvas-kit and session-summary plugins
canvases/<name>/               example canvases: canvas.ts, App.tsx, and tests
ui/                            components and the theme the canvases share
skills/                        skills that ship in the canvas-kit plugin
packages/canvas-kit/           @rwoll/canvas-kit
packages/create-canvas/        @rwoll/create-canvas
.github/workflows/             CI, the reusable marketplace workflow, publish, npm release
scripts/                       consumer test, npm publishing, repository protections
```

Add user-facing changes to the Unreleased section of [CHANGELOG.md](CHANGELOG.md):
the packages' API, CLI, templates, and the marketplace's plugins.

Changes reach `main` through pull requests that pass [CI](.github/workflows/ci.yml)
(and a code owner's review, once there is more than one maintainer). [Publish marketplace](.github/workflows/publish.yml) then
runs the reusable workflow, whose check is `pnpm check && pnpm e2e`. See
[RELEASING.md](RELEASING.md) for how `stable` and npm releases are protected.

To update the README images:

```sh
pnpm hero                           # docs/hero-*.png from docs/hero/hero.html
pnpm build
UPDATE_SCREENSHOTS=1 pnpm e2e screenshots --project light --project dark
```

## Supply chain

`pnpm-workspace.yaml` hardens installs:

- `minimumReleaseAge: 10080`: only versions published at least 7 days ago are
  installed, including transitive dependencies. With
  `minimumReleaseAgeIgnoreMissingTime: false`, a version the registry cannot date
  fails the install instead of skipping the check.
- `ignoreScripts: true`: dependency lifecycle scripts (`preinstall`, `install`,
  `postinstall`) never run, with `strictDepBuilds: true` as a backstop.

Every action the workflows use is locked to a commit in
`.github/workflows/actions.lock`. After adding a workflow or changing a `uses:`,
run [`gh actions-lock`](https://github.com/github/gh-actions-lock) and commit the
lockfile with it; CI's `actions-lock` check fails otherwise. Install it once with
`gh extension install github/gh-actions-lock`. Dependabot proposes action and npm
updates weekly with the same 7-day cooldown, and updates the lockfile itself. Workflows that
publish never restore a dependency cache. `.npmrc` points at the Microsoft package
feed; packages are published to registry.npmjs.org (see [RELEASING.md](RELEASING.md)).

Treat a pull request that changes `pnpm-lock.yaml`, `.npmrc`, `pnpm-workspace.yaml`, `vite.config.ts`,
`.github/`, `scripts/`, or `packages/canvas-kit/cli/` as security-relevant: they
decide what runs in the publishing workflows and in new marketplaces.
