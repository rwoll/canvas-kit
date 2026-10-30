# Releasing

Two things are released from this repository:

- **The `stable` branch**, which people install as a Copilot plugin marketplace:
  `copilot plugin marketplace add rwoll/canvas-kit#stable`. Every push to
  `main` publishes it.
- **The npm packages** `@rwoll/canvas-kit` and `@rwoll/create-canvas`, released
  together at the same version from a version tag.

Both run code on users' machines, so neither lets project or dependency code
touch the credential that publishes it.

## Publish `stable`

Merge to `main`. [Publish marketplace](.github/workflows/publish.yml) calls the
reusable [marketplace.yml](.github/workflows/marketplace.yml):

1. **build** (read-only token) installs with the frozen lockfile, runs
   `pnpm check && pnpm e2e` in a clean worktree, and prepares the next `stable`
   commit as a git bundle, only when the output changed. The run summary shows
   what changes.
2. **push** runs in the `stable` environment, then checks the bundle without
   running anything from it and fast-forwards `stable`:
   - the run is for `main`, and its commit is on `main`;
   - the bundle holds exactly one new commit on top of the current `stable`;
   - that commit names this run's commit as its only `Source-Commit`;
   - the current `stable` was built from an ancestor of it, so `stable` never
     goes back to older source.

## Release to npm

1. Bump `version` in `packages/canvas-kit/package.json` and
   `packages/create-canvas/package.json`, and merge to `main`.
2. Tag the merged commit and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.
   Only admins can create, move, or delete `v*` tags.
3. [Release to npm](.github/workflows/release.yml) runs three jobs:
   - **build** compiles and packs the tarballs, and records their hashes.
   - **test** runs every check, browser test, and the consumer test.
   - **publish** waits for the `npm` environment, checks the tag is on `main`,
     downloads the build job's artifact by ID, checks every tarball against the
     recorded hashes, and publishes with provenance. Nothing is installed or
     built in this job, and only it can request an npm token.

Versions already on npm are skipped, so rerunning a failed release is safe.
Prerelease tags such as `v0.2.0-beta.1` publish to the `next` dist-tag.

New marketplaces created by `canvas-kit init` pin `marketplace.yml` to the commit
their CLI was released from (`scripts/publish-npm.mjs` records it while packing),
so a later change here never runs in their workflows until they update the pin.

## How releases are protected

[`scripts/protect-repo.mjs`](scripts/protect-repo.mjs) applies the repository
settings. It is safe to rerun, and it tunes reviews to the number of maintainers
(people with write access): with one, pull requests need passing checks but no
approval, since GitHub doesn't let authors approve their own, and only npm
releases wait for approval. Rerun it after adding a maintainer to require a code
owner's review on pull requests and approval for `stable` too.

| Setting | What it does |
| --- | --- |
| `npm` environment | Only `v*` tags deploy, and a maintainer approves each release. |
| `stable` environment | Only `main` deploys. With more than one maintainer, a maintainer approves each publish; with one, merging to `main` is the approval. |
| Ruleset "Default branch" | Pull requests that pass `check` and `actions-lock`, plus a code owner's approval with more than one maintainer; no force pushes or deletion. Admins may bypass; workflow tokens may not. |
| Ruleset "Published branch" | `stable` is never force-pushed or deleted. Fast-forward pushes are not limited to the publish job yet; see [Going public](#going-public). |
| Ruleset "Release tags" | Only admins create, move, or delete `v*` tags. |
| Actions | Default token is read-only; only GitHub's actions and `pnpm/action-setup`, pinned to full commit SHAs. |
| [`actions.lock`](.github/workflows/actions.lock) | Every action runs at the commit the lockfile records, checked again by the runner. The required `actions-lock` check fails when it is out of date. A changed commit in it is a dependency update: review it like one. |
| Public only | Fork pull request approval for all outside contributors, private vulnerability reporting, secret scanning with push protection, Dependabot alerts. |

Workflows are locked with [gh-actions-lock](https://github.com/github/gh-actions-lock):
after changing any `uses:`, run `gh actions-lock` and commit the result. Dependabot
updates the lockfile together with the workflows. Workflows never restore a
dependency cache in a job that publishes, and pull
request runs (including from forks) get a read-only token, no secrets, and no
OIDC. Dependabot proposes action and npm updates weekly, after a 7-day cooldown.

On npmjs.com, for each package:

- **Settings → Trusted publishing**: GitHub Actions, this repository, workflow
  `release.yml`, environment `npm`. Under **Allowed actions**, also allow
  `npm publish`: publishers created since September 2026 allow only
  `npm stage publish` by default, and `release.yml` runs `npm publish`.
- **Settings → Publishing access**: "Require two-factor authentication and
  disallow tokens". Trusted publishing keeps working.
- Staged publishing (each CI release also approved with 2FA on npmjs.com) is not
  set up: it needs the publish job to run `npm stage publish` (npm 11.15.0 or
  later) before the trusted publisher is limited to staging.

## First publish

Done: both names were claimed with `0.0.0-placeholder` in October 2026. What
remains is steps 3 and 4.

npm trusted publishing can only be set up for a package that exists, and
provenance needs a public repository. No npm token goes into GitHub: the names
are claimed once from your machine, and every release after that comes from CI
through trusted publishing. So:

1. Make the repository public (see below).
2. Claim each name with a placeholder from your machine, with 2FA:

   ```sh
   mkdir /tmp/placeholder && cd /tmp/placeholder && npm init -y
   npm pkg set name=@rwoll/canvas-kit version=0.0.0-placeholder
   npm publish --access public --tag placeholder --registry https://registry.npmjs.org/
   ```

   Repeat for `@rwoll/create-canvas`.
3. Configure trusted publishing and publishing access as above. A new trusted
   publisher must publish within 2 days or npm drops it, so add it when you are
   ready to tag.
4. Release `v0.1.0` with a tag. It publishes from CI with provenance.

## Going public

1. Decide the package registry for contributors and CI: `.npmrc` points at a
   package feed proxy, and the lockfile records that feed's tarball URLs, which
   needs `trustLockfile: true` in `pnpm-workspace.yaml`. With the public registry,
   remove `trustLockfile` so pnpm re-checks the 7-day cooldown for every lockfile
   entry, and regenerate the lockfile so entries get sha512 hashes.
2. Make the repository public, then run `node scripts/protect-repo.mjs` again to
   add required reviewers and the public-only settings.
3. In **Settings → Actions → Policies**, add a policy with **Require lockfile**
   for all workflows, so a workflow that is not in `actions.lock` cannot run.
   It has no REST API yet.
4. Consider a dedicated identity for publishing `stable`: a deploy key (or GitHub
   App) whose secret lives only in the `stable` environment, and a "Published
   branch" ruleset that restricts updates to it. Then no workflow token needs
   `contents: write`, and no other workflow or collaborator can move `stable`.
   Today the push job uses the workflow token, so the ruleset can only block force
   pushes and deletion.
