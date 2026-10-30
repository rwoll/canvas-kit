# @rwoll/canvas-kit

**Copilot canvases you can change, test, and share.** Build the release boards,
triage queues, and review tools that you and your agent work in together: state
and actions in TypeScript, UI in React, and canvas-kit handles the rest.

- **React components.** Typed hooks wire your components to live state; share them
  across canvases to stay on brand.
- **Live, two-way canvases.** The agent's changes appear instantly, it reads yours,
  and a button can hand it the next task.
- **Saved, shared documents.** One board per repository: every chat on the release
  updates it, and tomorrow's chat picks up where today's left off.
- **Scheduled jobs.** Refresh pull request checks every 15 minutes or prune last
  week's triaged tests, even with no chat open. Users can pause or retime them.
- **A fast dev loop.** Preview changes live in your browser with no reinstalling,
  then test as the agent and the user with Playwright.
- **Share with one push.** `git push` publishes your canvases, skills, agents, and
  MCP servers for your users to install in two commands.

For a one-off view, plain HTML is fine. canvas-kit is for canvases you keep and
share. See the [project README](https://github.com/rwoll/canvas-kit#readme) for
screenshots and example canvases.

A canvas is an interactive panel that the agent opens with `open_canvas` and
drives with `invoke_canvas_action`. A canvas package declares its state and
actions once, and the kit supplies everything else. This guide covers the API.

## Quickstart

```sh
npm create @rwoll/canvas my-marketplace -- --repository me/my-marketplace --canvas release-board
cd my-marketplace
pnpm install
pnpm --filter release-board dev   # the canvas in a browser, with live actions
pnpm check                        # build, typecheck, unit tests
```

Push it to GitHub and every push to `main` publishes the marketplace to the
`stable` branch. Install it with
`copilot plugin marketplace add me/my-marketplace#stable`.

Add more canvases with `pnpm new-canvas <name>` (`canvas-kit new`). You edit two
files per canvas: `server/canvas.ts` for state and actions, and `src/App.tsx` for
the UI.

## What the kit provides

- **Copilot SDK registration**: `joinSession`/`createCanvas` wiring, a built-in
  `get_state` action, JSON Schemas generated from Zod, and `CanvasError` mapping.
- **Loopback server**: one `127.0.0.1` server per extension on an ephemeral port,
  stopped when the last instance closes. Pages get a per-instance token embedded in
  the HTML (never the URL), and the server checks `Host`, `Origin`, and the token.
- **Live state**: every `setState` is validated and pushed to open pages over
  server-sent events. Actions on one document run one at a time; if an action
  throws or its state cannot be saved, the state rolls back.
- **Persistence (optional)**: atomic, validated JSON files under
  `<copilot-home>/extension-data/<canvas-id>/`, keyed by a domain identity. They
  outlive the agent, and every chat that opens the same key shares one document:
  changes apply one at a time under a cross-process lock, and open pages in other
  chats update live.
- **Scheduled jobs (optional)**: `jobs` run on an interval while a chat has the
  canvas open, once per interval across chats, and `canvas-kit run` runs them with
  no chat open, from launchd or cron. Users and the agent can pause, retime, run,
  and add jobs when the canvas allows it.
- **Build**: one `vite build` writes an installable plugin to `dist/plugin/`:
  the React UI, a single bundled `extension.mjs` (dependencies included; only the
  host-provided `@github/copilot-sdk` and Node.js built-ins stay external), the
  plugin manifest generated from `package.json`, and `canvas.mjs`, the definition
  without the SDK, for `canvas-kit run`.
- **Dev server**: `vite` serves the UI with the canvas definition running
  in-process, so actions and live updates work in a normal browser. To preview
  what only the agent can do, such as a tour, run an agent action with a
  same-origin `POST /__canvas/dev/agent/<action>` and a JSON body. This route
  exists only in the dev server.
- **Version footer**: every page has a small footer pinned to the bottom of the
  viewport, such as
  `changeset-review v0.3.0 · Published Oct 22, 2026, 7:41 PM`. The version comes from
  `package.json`, and the publish time and source commit (in the tooltip) come from
  the `release.json` stamp that `canvas-kit release` writes. Unpublished builds say
  `Local build, not published`; the dev server says `Dev server`.
- **Tests**: `createTestCanvas` for unit tests and `canvasTest` fixtures for
  Playwright browser tests against the built canvas.
- **Marketplace tooling**: the `canvas-kit` command scaffolds canvases, assembles a
  plugin marketplace, and publishes it to a branch. A reusable GitHub Actions
  workflow runs it on every push.

## Canvas package layout

```text
canvases/<name>/
  package.json         name, version, and description become the plugin manifest
  index.html           Vite entry
  vite.config.ts       plugins: [canvasKit()]
  server/canvas.ts     export default defineCanvas({...})   (Node.js)
  server/*.test.ts     unit tests (Vitest)
  src/                 React UI; import only types from server/
  e2e/*.spec.ts        browser tests (Playwright)
  playwright.config.ts export default defineCanvasConfig()
```

The folder name is the plugin name and extension folder name.

## Defining a canvas

```ts
import { defineCanvas, z } from '@rwoll/canvas-kit'

export default defineCanvas({
  id: 'octo-release-board',           // stable, distinctive, kebab-case
  title: 'Release board',
  description: 'Track release blockers for a repository.',
  state: z.object({ repo: z.string(), blockers: z.array(z.string()) }),
  input: z.object({ repo: z.string() }),            // optional open_canvas input
  init: ({ input }) => ({ repo: input.repo, blockers: [] }),
  persist: { key: ({ input }) => input.repo },      // optional private persistence
  actions: ({ action }) => ({
    add_blocker: action({
      description: 'Add a release blocker.',
      input: z.object({ text: z.string().min(1).max(500) }),
      run: (ctx, { text }) => ctx.setState(s => ({ ...s, blockers: [...s.blockers, text] })),
    }),
    clear: action({ description: 'Clear all blockers.', expose: 'agent', run: ctx => ctx.setState(s => ({ ...s, blockers: [] })) }),
  }),
})
```

- `expose` is `'both'` (default), `'agent'`, or `'ui'`.
- `reopen({ instanceId, input, state })` runs when an open instance or a saved
  document is opened again; return new state, or nothing to keep it. Opening an
  instance with input that maps to a different `persist.key` switches it to that
  document.
- `ctx.source` tells an action whether the agent or the UI called it; `ctx.log()`
  writes to the session log. Never use `console.log` in extension code.
- `ctx.sendToAgent({ prompt, displayPrompt?, mode? })` messages the agent, for
  example when the user submits feedback from the canvas. Keep the prompt short and
  put bulky details in a file under `ctx.dataDir`, the canvas's private folder, so
  the agent reads them only when needed. In the dev server, messages are printed to
  the Vite log; in tests they are recorded in `harness.sentToAgent`.
- Throw `new CanvasKitError(code, message)` for expected failures.
- `get_state` is added automatically unless you define your own.
- Set `versionFooter: false` to hide the version footer. The same information is
  available to the UI as `getCanvasClient().release` if you render your own.
- Pages get a strict Content-Security-Policy: `default-src 'none'`, with scripts and
  connections limited to the canvas's own origin. A canvas that must reach a
  local service can add `scheme://host[:port]` sources to `connect-src` with
  `csp: { connectSrc: ['ws://127.0.0.1:*'] }`. The sources apply to that canvas only;
  keywords, paths, and bare wildcards are rejected. The dev server sets no CSP, so
  check such a canvas in a built plugin too.
- When `persist` is set, the saved file carries a format marker and version. A
  corrupt file or one with a different `persist.version` is reported, never
  overwritten. Bump the version when the state shape changes incompatibly.
- `ctx.now()` is the current time in milliseconds. Use it instead of `Date.now()`
  so tests can control the clock.

## Shared documents and scheduled jobs

With `persist`, a document belongs to its key, not to a chat. It stays on disk
after the agent and the session end, and every chat that opens the same key works
on the same document:

- Each action, reopen, and job takes a lock on the document's file, reloads the
  latest saved revision, runs, and saves the next revision. Changes from different
  chats apply one at a time, so none is lost.
- Pages in every chat with the document open update live when another chat
  changes it. The host watches the saved files, and also checks them every 2
  seconds in case the operating system drops a change notification.
- The first open creates the document with `init()`, under the same lock, so
  chats that open a new key at the same time start from the same state.
- A lock held by a process that exited is taken over at once; one that stops
  being refreshed for 15 seconds is taken over as stale. A change that waits more
  than 30 seconds for the lock fails with `busy`.

Jobs keep a document up to date on a schedule:

```ts
export default defineCanvas({
  // ...
  persist: { key: ({ input }) => input.repo },
  jobs: ({ job }) => ({
    prune_triaged: job({
      every: '1h',                                  // 30s, 15m, 6h, 1d, or milliseconds
      description: 'Remove tests triaged more than a week ago.',
      run: (ctx) => {
        const cutoff = ctx.now() - 7 * 24 * 60 * 60 * 1000
        ctx.setState((s) => ({ ...s, tests: s.tests.filter((t) => !t.triagedAt || Date.parse(t.triagedAt) > cutoff) }))
      },
    }),
    nudge: job({
      every: '1d',
      run: async (ctx) => {
        if (ctx.headless) return                    // no agent under `canvas-kit run`
        await ctx.sendToAgent({ prompt: `${ctx.state.tests.length} flaky tests are open in ${ctx.key}` })
      },
    }),
  }),
})
```

- While any chat has the canvas open, its due jobs run for each open document,
  soon after opening and then on a timer. The last run time is saved in the
  document and checked under the lock, so with several chats open a job still runs
  once per interval, and an overdue job runs once to catch up.
- `ctx` has the state, `setState`, `sendToAgent`, `log`, `dataDir`, `now()`, the
  document `key`, and `lastRunAt`. A job that throws has its changes rolled back
  and its error saved with the run time; it runs again at the next interval.
- A job holds the document's lock while it runs, so actions in every chat wait
  for it. Keep jobs short: fetch slow data before changing state, or do it in
  several runs.
- Without `persist`, jobs run per instance while it is open.
- Job names are snake_case, and `every` is at least one second.

### Letting people control jobs

Jobs are code, so users cannot write new ones. With `controls`, the UI, the agent,
or both can pause, resume, retime, and run a job, and add jobs from a job that
takes `input`:

```ts
jobs: ({ job }) => ({
  prune_triaged: job({
    every: '1h',
    controls: 'both',          // 'ui', 'agent', or 'both'; omit to leave it to code
    minEvery: '15m',           // the range users may pick from; defaults to every..30d
    maxEvery: '7d',
    run: (ctx) => { /* ... */ },
  }),
  recurring_check: job({       // with input, users add jobs from it; it never runs on its own
    every: '7d',               // the default for added jobs
    controls: 'both',
    input: z.object({ text: z.string().min(1).max(300) }),
    maxJobs: 10,               // per document
    run: (ctx, { text }) => { /* ... */ },
  }),
}),
```

```tsx
const { useJobs } = createCanvasHooks<typeof canvas>()

function Schedule() {
  const { jobs, definitions, update, run, add, remove, pending, error } = useJobs()
  // jobs: [{ id: 'prune_triaged', every: 3600000, enabled: true, lastRunAt, nextRunAt, lastError, ... },
  //        { id: 'recurring_check-3f9a2c', job: 'recurring_check', input: { text }, added: true, ... }]
  update('prune_triaged', { enabled: false })                  // pause; { enabled: true } resumes
  update('prune_triaged', { every: '6h' })                     // within minEvery..maxEvery
  run('prune_triaged')                                         // now, even if paused
  add('recurring_check', { text: 'Check security sign-off' }, { every: '1d' })   // typed input
  remove('recurring_check-3f9a2c')
}
```

- Settings and added jobs are saved in the document with the run history, so they
  are shared live by every chat and used by `canvas-kit run`.
- A job's ID is its name, or `<name>-<hex>` for an added job. An added job runs
  soon after it is added, then on its interval. Its input is checked against the
  schema when it is added and before every run.
- The agent gets `list_jobs`, `update_job`, and `run_job` actions, plus `add_job`
  and `remove_job` when a job takes input, covering only the jobs whose `controls`
  include it. The UI calls the same actions through `useJobs()`.
- `formatInterval(ms)` turns an interval into text such as `6h`, and
  `intervalMs('6h')` turns it back.

### Running jobs with no chat open

Nothing in the session runs after it ends. To run jobs with no chat open, run
`canvas-kit run` on a schedule. It runs every job that is due and not paused, for
every saved document, including jobs users added. Name a job or ID to run only
it, pass `--key` for one document, or `--force` to run even if not due or paused.
Jobs run with `ctx.headless` set, where `sendToAgent` fails. It uses the same lock,
so it is safe while chats have the canvas open.

```sh
# In a canvas package after `pnpm build`, or with --plugin for an installed plugin
npx @rwoll/canvas-kit run
npx @rwoll/canvas-kit run prune_triaged --plugin ~/.copilot/installed-plugins/my-marketplace/flaky-tests
```

In a canvas package, `npx` runs the `@rwoll/canvas-kit` it installed; elsewhere it
downloads it. Always give the scoped name: the unscoped `canvas-kit` on npm is a
different package.

Run it at least as often as the shortest interval users may pick. For example,
every 15 minutes with cron (`crontab -e`):

```text
*/15 * * * * cd ~/canvases/flaky-tests && npx @rwoll/canvas-kit run >> /tmp/flaky-tests-jobs.log 2>&1
```

Or with a launchd agent on macOS, in `~/Library/LaunchAgents/com.example.flaky-tests-jobs.plist`, loaded
with `launchctl load ~/Library/LaunchAgents/com.example.flaky-tests-jobs.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.flaky-tests-jobs</string>
  <key>WorkingDirectory</key><string>/Users/me/canvases/flaky-tests</string>
  <key>ProgramArguments</key>
  <array><string>/opt/homebrew/bin/npx</string><string>@rwoll/canvas-kit</string><string>run</string></array>
  <key>StartInterval</key><integer>900</integer>
</dict>
</plist>
```

The job runs on your machine because the documents are there; hosted CI such as
GitHub Actions cannot reach them. Work that needs the agent needs a live chat.

## Using it from React

```tsx
import { createCanvasHooks } from '@rwoll/canvas-kit/react'
import type canvas from '../server/canvas.ts'

const { useCanvas, useAction } = createCanvasHooks<typeof canvas>()

function App() {
  const { state, status } = useCanvas()               // typed state, 'connecting' | 'live' | 'offline'
  const [addBlocker, { pending, error }] = useAction('add_blocker')
  // addBlocker({ text }) is type-checked against the action's Zod input
}
```

`state` is available on the first render because the server embeds it in the
page. `useJobs()` shows and controls scheduled jobs; see
[Letting people control jobs](#letting-people-control-jobs). Import `@rwoll/canvas-kit/styles.css` for the shared light/dark theme.

UI code runs in the browser. The build fails if `src/` imports a Node.js module;
do that work in an action instead.

Keep canvas UIs flat and quiet, in the style of the Session summary canvas.
Separate sections with spacing or a single hairline instead of decorative
cards: no bordered or rounded containers, shadows, or outlined pills. Use plain
or muted text for metadata, and text links for secondary actions. A highlight
that helps people find the most important content, such as Session summary's
tinted executive summary, is the exception.

## Sharing components and a theme

A marketplace's `ui/` package holds the React components and the theme its canvases
share. `canvas-kit init` creates it (`@<marketplace>/ui`), `canvas-kit ui` adds it to
an existing marketplace, and `canvas-kit new` makes each new canvas depend on it,
import its `theme.css`, and use its `Header`.

```text
ui/package.json    "name": "@my-canvases/ui", "exports": { ".": "./src/index.ts", "./theme.css": "./theme.css" }
ui/theme.css       brand variables (--accent, --accent-contrast, ...) and component styles
ui/src/            Header, Markdown, Checklist, TextButton; add your own
```

`theme.css` overrides the variables of `@rwoll/canvas-kit/styles.css`, so import it
second. It is plain TypeScript source in the workspace: each canvas's Vite build
bundles it, so the published plugins need nothing extra at run time.

## Testing

Unit tests run the canvas on a real local server with a temporary data folder:

```ts
import { createTestCanvas } from '@rwoll/canvas-kit/testing'

const harness = await createTestCanvas(canvas)
await harness.open('test', { repo: 'octo/app' })
await harness.invoke('test', 'add_blocker', { text: 'CI red' }, 'ui')
expect(harness.state('test')?.blockers).toEqual(['CI red'])
expect(harness.sentToAgent).toEqual([])          // what ctx.sendToAgent() sent
await harness.runJob('prune_triaged')            // run a job now; tickJobs() runs only due ones
await harness.invoke('test', 'update_job', { id: 'prune_triaged', enabled: false }, 'ui')   // as useJobs() does
expect(harness.jobs('test')?.[0]?.enabled).toBe(false)
await harness.close()
```

Browser tests use Playwright fixtures against the **built** canvas, so they run
with the same Content-Security-Policy and bundling as the installed plugin.
Build first (`pnpm build`) and install Chromium once (`pnpm -r --workspace-concurrency=1 run playwright:install`).

```ts
// e2e/board.spec.ts
import { canvasTest, expect } from '@rwoll/canvas-kit/playwright'
import canvas from '../server/canvas.ts'

const test = canvasTest(canvas)

test('the user and the agent share the board', async ({ openCanvas, agent, seed }) => {
  await seed('octo/app', { repo: 'octo/app', blockers: [] })   // saved state, before opening
  const { page, state, openAnotherPage } = await openCanvas({ repo: 'octo/app' })

  await page.getByLabel('New blocker').fill('CI red')
  await page.getByRole('button', { name: 'Add' }).click()
  await agent.invoke('clear_resolved')                           // act as the agent
  expect(agent.messages).toEqual([])                             // what the canvas sent the agent
  agent.failNextSend()                                           // the next send fails
  const other = await openAnotherPage()                          // a second view of the instance
})
```

| Fixture | What it does |
| --- | --- |
| `openCanvas(input?, { instanceId? })` | Opens an instance, points `page` at it, and waits until it is live (`html[data-canvas-status="live"]`). Returns `page`, `url`, `state()`, and `openAnotherPage()`. |
| `agent` | `invoke(action, input?)` as the agent, `messages` sent with `ctx.sendToAgent()`, and `failNextSend()`. |
| `seed(key, state)` | Saves state for a `persist` key before the canvas opens. |
| `runJob(id, { key?, force?, headless? })` | Runs a job now, by name or added job ID, for the latest instance or a saved document with `key`. |
| `canvasHarness` | The underlying `createTestCanvas` harness. |

Jobs run only through `runJob` and `harness.tickJobs()` in tests. To test
time-based jobs, pass a clock to both harnesses, `createTestCanvas(canvas, { now })`
and `canvasTest(canvas, { now })`, and move it forward between steps.

`defineCanvasConfig(overrides?)` in `playwright.config.ts` runs `e2e/` in light,
dark, and high-contrast Chromium. Canvas UIs show server state, so after a click,
assert with web-first assertions such as `toBeChecked()` rather than `check()`,
which expects the change at the moment of the click. Vitest skips `e2e/`.

## The canvas-kit command

A marketplace repository has `marketplace.config.json`, content-only plugins in
`plugins/<name>/` (skills, agents, MCP servers), and canvases in `canvases/<name>/`.

```json
{
  "name": "my-marketplace",
  "owner": { "name": "me" },
  "repository": "me/my-marketplace",
  "publishBranch": "stable",
  "sourceBranch": "main"
}
```

| Command | What it does |
| --- | --- |
| `canvas-kit init <dir> --repository owner/name [--canvas name]` | Creates a marketplace repository with a shared `ui/` package (what `npm create @rwoll/canvas` runs). |
| `canvas-kit new <name> [--title] [--description] [--id] [--catalog] [--kit <range>]` | Adds a canvas package, wired to the shared UI package when the config names one. `--catalog` writes pnpm `catalog:` ranges. |
| `canvas-kit ui <package-name> [--catalog]` | Adds a shared UI package (`ui/`) to an existing marketplace and records it as `ui`. |
| `canvas-kit build` | Assembles `dist/marketplace` from `plugins/` and each canvas's `dist/plugin`, with a catalog generated from the plugin manifests. |
| `canvas-kit run [job] [--plugin] [--canvas] [--key] [--force] [--data-root]` | Runs a canvas's due jobs (or one job by name or ID) for its saved documents with no chat open, from a built plugin (`./dist/plugin` by default). Exits non-zero when a run fails. |
| `canvas-kit release [--dry-run] [--skip-checks]` | Builds the source branch in a clean worktree with a frozen-lockfile install, runs the `check` script (or `build`), and commits the output to the publish branch only when it changed. Each plugin gets a `release.json` stamp that the version footer shows. |

Optional config: `ui` (the shared UI package new canvases use), `pluginsDir`,
`canvasesDir`, `outDir`, `checkScript`, and
`installCommand`, `checkCommand`, or `buildCommand` to replace the detected
package manager commands. The library behind the command is
`@rwoll/canvas-kit/cli`.

## GitHub Actions

Publish on every push with the reusable workflow, pinned to a release commit.
`canvas-kit init` writes this for you with the commit your CLI was released from:

```yaml
# .github/workflows/publish.yml
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
      playwright: true      # when your check script runs browser tests
      environment: stable   # optional: approve each publish
```

It runs two jobs, so your dependencies never see a token that can write:

- **build** (read-only token) installs with the frozen lockfile, runs your
  `check` script in a clean worktree, and prepares the next publish-branch commit
  as a git bundle when the output changed.
- **push** (`contents: write`) runs no project code. It checks that the bundle is
  one commit on top of the publish branch, built from this run's commit on your
  source branch and newer than what is published, then fast-forwards the branch.

Inputs: `working-directory` (the folder with `marketplace.config.json`),
`node-version`, `playwright`, `dry-run`, `environment` (a GitHub environment for
the push job; give it required reviewers and limit it to your source branch),
`source-branch` (defaults to the repository's default branch), and
`publish-branch` (defaults to `stable`; the push job writes only that branch). Neither job
restores a dependency cache. Pin the workflow to a full commit SHA and let
Dependabot update it; `canvas-kit init` adds a `dependabot.yml` that does. The
workflow's own actions are locked in this repository's `actions.lock`, so it runs
under a **Require lockfile** policy.

Lock your marketplace's actions too: run
[`gh actions-lock`](https://github.com/github/gh-actions-lock) after `canvas-kit init`
and whenever you change a `uses:`, and commit `.github/workflows/actions.lock`. The
scaffolded `check.yml` verifies it on every pull request once it exists.

## Entry points

| Import | Runs in | Purpose |
| --- | --- | --- |
| `@rwoll/canvas-kit` | Node.js | `defineCanvas`, `z`, `CanvasKitError`, types |
| `@rwoll/canvas-kit/react` | Browser | `useCanvas`, `useAction`, `useJobs`, `createCanvasHooks`, `formatInterval` |
| `@rwoll/canvas-kit/client` | Browser | Framework-free `CanvasClient` |
| `@rwoll/canvas-kit/testing` | Node.js | `createTestCanvas` |
| `@rwoll/canvas-kit/playwright` | Playwright | `canvasTest`, `defineCanvasConfig`, `expect` |
| `@rwoll/canvas-kit/cli` | Node.js | `initMarketplace`, `newCanvas`, `buildMarketplace`, `release`, `runJob` |
| `@rwoll/canvas-kit/server` | Node.js | `CanvasHost`, `StateStore`, `runCanvasJob`, `copilotHome` |
| `@rwoll/canvas-kit/extension` | Node.js | SDK adapter used by the generated entry |
| `@rwoll/canvas-kit/vite` | Build | `canvasKit()` Vite plugin |
| `@rwoll/canvas-kit/styles.css` | Browser | Base theme |
| `@rwoll/canvas-kit/tsconfig/*.json` | Build | Shared TypeScript settings |

`react`, `vite`, `@playwright/test`, and `@github/copilot-sdk` are peer
dependencies; install the ones you use. The Copilot host supplies the SDK at run
time, so it is needed only for types.
