# Changelog

Notable changes to [`@rwoll/canvas-kit`](packages/canvas-kit) and
[`@rwoll/create-canvas`](packages/create-canvas), which are released together at
the same version, and to the plugins in this repository's marketplace. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/); before 1.0, a minor version can
break things.

## [Unreleased]

### Changed

- **Breaking:** a marketplace is one project instead of a package per canvas. Each
  canvas is a folder, `canvases/<name>/`, with `canvas.ts` (state and actions),
  `App.tsx` (its React UI), and its tests. The project has one `package.json`,
  `vite.config.ts`, `tsconfig.json`, and `playwright.config.ts`. Pages and UI
  entries are generated, so canvases have no `index.html` or `main.tsx`.
- **Breaking:** `vite build` writes one plugin, named after the project, to
  `dist/plugins/<name>/`. It holds every canvas, which runs in one extension
  process per chat, and the project's `skills/`. List canvases in
  `canvasKit({ plugins })` to publish them as plugins of their own.
- **Breaking:** the shared UI is a plain `ui/` folder that canvases import as
  `../../ui`, not a workspace package. `canvas-kit ui` takes no package name, and
  `marketplace.config.json` no longer has `ui` or `canvasesDir`.
- **Breaking:** `@rwoll/canvas-kit/tsconfig/project.json` replaces `canvas.json` and
  `node.json`.
- **Breaking:** browser tests are `canvases/**/*.spec.ts`. `canvasTest()` finds the
  canvas's built page from the spec's folder, and Vitest runs only `*.test.ts`.
- **Breaking:** `canvasKit({ devInput })` is keyed by canvas folder name, such as
  `{ 'release-board': { repo: 'octo/app' } }`. A key that is not a canvas fails
  the config.
- **Breaking:** `runCanvasExtension()` takes a list of canvases and returns
  `hosts`, a host for each, instead of `host`.
- `vite` serves every canvas at `/<name>/`, with a list of them at `/`.
- `canvas-kit run` looks in every plugin in `dist/plugins/`; `--canvas` picks a
  canvas by folder name or ID. It still runs plugins built by 0.1.
- This repository's marketplace has two plugins: `canvas-kit`, with the skills and
  the example canvases, and `session-summary`. They replace `canvas-kit-skills`,
  `flaky-tests`, and `release-board`; uninstall those and install `canvas-kit`.

### Added

- Canvases can follow the agent in their chat
  ([#8](https://github.com/rwoll/canvas-kit/pull/8)):
  - `ctx.sessionId` in actions, jobs, `init`, `reopen`, and `persist.key`.
  - `ctx.agent` (`busy`, `lastActivityAt`, `idleSince`) in actions and jobs, and
    `useCanvas().agent` in pages.
  - `ctx.manual`, `ctx.every`, and `ctx.instanceIds` in jobs.
  - A fake session in `createTestCanvas()` and the Playwright fixtures, with
    `sessionEvent()`.
- The Session summary canvas: an executive summary of the chat's work that the
  agent keeps up to date on a schedule
  ([#8](https://github.com/rwoll/canvas-kit/pull/8)).
- `InlineMarkdown`, and `choices` for `IntervalSelect`, in the example `ui/`.

## [0.1.1] - 2026-10-30

### Changed

- The `@rwoll/canvas-kit` README on npm leads with what canvas-kit does
  ([#6](https://github.com/rwoll/canvas-kit/pull/6)).
- Docs, skills, and CLI messages use the scoped `npx @rwoll/canvas-kit` command,
  since the unscoped `canvas-kit` on npm is a different package
  ([#3](https://github.com/rwoll/canvas-kit/pull/3)).

## [0.1.0] - 2026-10-29

First release: typed canvas state and actions with Zod, a secure local host, React
hooks, saved documents shared across chats, scheduled jobs, Vitest and Playwright
helpers, the `canvas-kit` command, and `npm create @rwoll/canvas`.

[Unreleased]: https://github.com/rwoll/canvas-kit/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/rwoll/canvas-kit/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/rwoll/canvas-kit/releases/tag/v0.1.0
