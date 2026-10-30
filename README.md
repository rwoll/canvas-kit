<img src="docs/logo.png" alt="canvas-kit logo: a chat bubble opening a canvas panel with a checklist" width="96" align="right">

# canvas-kit

**Copilot canvases you can change, test, and share.** Your agent (or you) writes
two TypeScript files: the state and actions, and a React UI. canvas-kit supplies
the rest: a secure local server, live updates, saved state, shared components and
theme, browser tests, and prebuilt releases.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![Zod](https://img.shields.io/badge/Zod-3E67B1?logo=zod&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/hero-dark.png">
  <img alt="A Copilot window: the chat opens three canvases (Release board, Flaky tests, PR queue) that each render the agent's notes with the same shared React Markdown component. Below, in your repo: a type error caught at compile time, a Playwright test passing in light, dark, and high-contrast, and git push publishing prebuilt canvases that a teammate installs with two commands." src="docs/hero-light.png">
</picture>

## Why canvas-kit?

An agent can write a raw HTML canvas that works on day one. canvas-kit is for the
canvases you keep changing and sharing.

| | Raw HTML canvas | canvas-kit |
| --- | --- | --- |
| Contract | Agent schema, server checks, and UI synced by hand | One Zod schema: agent JSON Schema, runtime checks, React types |
| Security | Own server, token checks, and CSP in every canvas | Loopback only, per-instance token, `Host` and `Origin` checks, strict CSP |
| State | Saving and concurrency written per canvas | Saved documents outlive the agent and are shared live across chats; changes apply one at a time under a lock and roll back on failure |
| Schedules | A timer that stops with the chat | `jobs` run once per interval across chats; users and the agent pause, retime, and add them; `canvas-kit run` runs them from cron or launchd with no chat open |
| Look and feel | Each canvas styles itself | Shared React components and one theme in a `ui/` package |
| Tests | Usually by clicking around | Unit tests on a real server; Playwright in light, dark, and high contrast |
| Sharing | Copy files or script your own release | `git push` publishes prebuilt; the footer shows which build runs |

**Who it's for:** people who build canvases with Copilot and keep them, and teams
or plugin authors who share them through a marketplace. For a one-off view, ask
the agent for raw HTML.

## Try it

```sh
copilot plugin marketplace add rwoll/canvas-kit#stable
copilot plugin install release-board@canvas-kit
copilot plugin install flaky-tests@canvas-kit
```

Reload extensions, start a new chat, and ask:

> Open the release board for octo/app and add a blocker: CI is red on main.

## Build your own

```sh
npm create @rwoll/canvas my-canvases -- --repository you/my-canvases --canvas release-board
cd my-canvases
pnpm install
pnpm --filter release-board dev      # opens the canvas in your browser, live
```

A canvas is two files. `server/canvas.ts` holds the state and the actions that the
agent and the UI both call:

```ts
import { defineCanvas, z } from '@rwoll/canvas-kit'

export default defineCanvas({
  id: 'you-release-board',
  title: 'Release board',
  description: 'Track release blockers for a repository with the agent.',
  input: z.object({ repo: z.string() }),
  state: z.object({ repo: z.string(), blockers: z.array(z.object({ id: z.string(), text: z.string(), resolved: z.boolean() })) }),
  init: ({ input }) => ({ repo: input.repo, blockers: [] }),
  persist: { key: ({ input }) => input.repo },
  actions: ({ action }) => ({
    add_blocker: action({
      description: 'Add a release blocker to the board.',
      input: z.object({ text: z.string().min(1).max(300) }),
      run: (ctx, { text }) =>
        ctx.setState((s) => ({ ...s, blockers: [...s.blockers, { id: crypto.randomUUID(), text, resolved: false }] })),
    }),
  }),
})
```

`src/App.tsx` is the UI, typed from the server file:

```tsx
import { createCanvasHooks } from '@rwoll/canvas-kit/react'
import type canvas from '../server/canvas.ts'

const { useCanvas, useAction } = createCanvasHooks<typeof canvas>()

export default function App() {
  const { state } = useCanvas()
  const [addBlocker, { pending }] = useAction('add_blocker')
  return (
    <main>
      <h1>{state.repo}</h1>
      <button disabled={pending} onClick={() => addBlocker({ text: 'CI is red on main' })}>Add</button>
      <ul>{state.blockers.map((b) => <li key={b.id}>{b.text}</li>)}</ul>
    </main>
  )
}
```

## Reuse components and one theme

The scaffold adds a shared `ui/` package. Every canvas imports its React components
and `theme.css`, so canvases look alike and a brand change lands everywhere at once.

```text
ui/                        @my-canvases/ui: Header, Markdown, Checklist, TextButton, theme.css
canvases/release-board/
canvases/flaky-tests/      `canvas-kit new` wires every new canvas to ui/
```

```css
/* ui/theme.css: your brand, once */
:root { --accent: #0b6bcb; }
```

```tsx
// canvases/flaky-tests/src/App.tsx
import { Checklist, Header, Markdown } from '@my-canvases/ui'

<Header title="Flaky tests" meta={`${state.repo} · ${open} to triage`} />
<Checklist label="Flaky tests" items={items} onToggle={(id, done) => setTriaged({ id, triaged: done })} />
<Markdown label="Triage notes">{state.notes}</Markdown>   {/* the agent's Markdown; raw HTML stays text */}
```

Both example canvases in this repository use [`ui/`](ui):

<table>
  <tr>
    <td>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/release-board-dark.png">
        <img alt="Release board canvas built from the shared Header, Markdown notes, and Checklist" src="docs/release-board-light.png">
      </picture>
    </td>
    <td>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/flaky-tests-dark.png">
        <img alt="Flaky tests canvas built from the same Header, Checklist, and Markdown notes" src="docs/flaky-tests-light.png">
      </picture>
    </td>
  </tr>
</table>

## Test it

```ts
// e2e/canvas.spec.ts: Playwright against the built canvas
import { canvasTest, expect } from '@rwoll/canvas-kit/playwright'
import canvas from '../server/canvas.ts'

const test = canvasTest(canvas)

test('the user and the agent share the board', async ({ openCanvas, agent }) => {
  const { page } = await openCanvas({ repo: 'octo/app' })
  await page.getByRole('button', { name: 'Add' }).click()
  await agent.invoke('add_blocker', { text: 'Docs missing' })
  await expect(page.getByRole('listitem')).toHaveCount(2)
})
```

```sh
pnpm check                          # build, typecheck, unit tests
pnpm -r --workspace-concurrency=1 run playwright:install      # once
pnpm e2e                            # light, dark, and high-contrast
```

## Share it

```sh
git push        # builds every canvas and publishes them, prebuilt, to the stable branch
```

Your team installs them with no build step:

```sh
copilot plugin marketplace add you/my-canvases#stable
copilot plugin install release-board@my-canvases
```

The scaffold's publish workflow is pinned to the kit release you created it with:

```yaml
jobs:
  publish:
    permissions:
      contents: write
    uses: rwoll/canvas-kit/.github/workflows/marketplace.yml@<commit> # v0.1.0
```

Your build runs with a read-only token; a separate job that runs none of your
code pushes the result. Add `environment: stable` to approve each publish.

## Let Copilot build it

```sh
copilot plugin install canvas-kit-skills@canvas-kit
```

> Build a canvas that lists this week's flaky tests and lets me mark them triaged.

The skills teach the agent to build canvases (`canvas-kit`), test them
(`canvas-kit-testing`), and publish them (`canvas-kit-publishing`).

## What's here

| | |
| --- | --- |
| [`canvases/release-board`](canvases/release-board) · [`canvases/flaky-tests`](canvases/flaky-tests) | Example canvases, with unit and browser tests |
| [`ui`](ui) | The React components and theme both canvases share |
| [`plugins/canvas-kit-skills`](plugins/canvas-kit-skills) | Skills that teach agents to build, test, and publish canvases |
| [`packages/canvas-kit`](packages/canvas-kit) | The library and `canvas-kit` command ([API guide](packages/canvas-kit/README.md)) |
| [`packages/create-canvas`](packages/create-canvas) | `npm create @rwoll/canvas` |
| [`marketplace.yml`](.github/workflows/marketplace.yml) | Reusable publish workflow |

This repository is itself a canvas-kit marketplace: the commands above install
from its `stable` branch. See [CONTRIBUTING.md](CONTRIBUTING.md) to work on it,
[RELEASING.md](RELEASING.md) for how releases are protected, and
[SECURITY.md](SECURITY.md) to report a vulnerability. MIT licensed.
