---
name: canvas-kit-testing
description: "Write and run unit tests (Vitest) and browser tests (Playwright) for a canvas built with @rwoll/canvas-kit. Use when adding or fixing canvas tests, or when a canvas change needs verification."
---

# Test a canvas

Every canvas gets two kinds of tests. Both run the canvas on a real local server
with a temporary data folder, so they never touch the user's saved state.

## Unit tests: `server/*.test.ts`

Test actions, validation, persistence, and messages to the agent:

```ts
import { createTestCanvas } from '@rwoll/canvas-kit/testing'
import { afterEach, expect, it } from 'vitest'
import canvas from './canvas.ts'

let close: (() => Promise<void>) | undefined
afterEach(() => close?.())

it('adds blockers and keeps one board per repository', async () => {
  const harness = await createTestCanvas(canvas)
  close = harness.close
  await harness.open('a', { repo: 'octo/app' })
  await harness.invoke('a', 'add_blocker', { text: 'CI is red' }, 'ui')   // last argument: 'ui' or 'agent' (default)
  expect(harness.state('a')?.blockers).toHaveLength(1)
  await expect(harness.invoke('a', 'add_blocker', { text: '' })).rejects.toMatchObject({ code: 'invalid_input' })

  await harness.open('b', { repo: 'octo/app' })                           // same persist key, same board
  expect(harness.state('b')?.blockers).toHaveLength(1)
  expect(harness.sentToAgent).toEqual([])                                  // what ctx.sendToAgent() sent
})

it('prunes resolved blockers hourly', async () => {
  let now = Date.parse('2026-10-01T09:00:00Z')
  const harness = await createTestCanvas(canvas, { now: () => now })      // ctx.now() in actions and jobs
  close = harness.close
  await harness.open('a', { repo: 'octo/app' })
  expect(await harness.runJob('prune_resolved')).toMatchObject({ ran: true })   // runs now
  now += 60 * 60 * 1000
  await harness.tickJobs()                                                 // runs only the due jobs
})
```

Jobs never run on their own in tests; use `runJob` and `tickJobs`. Test job
controls by invoking the built-in actions as the UI does, for example
`harness.invoke('a', 'add_job', { job: 'recurring_check', input: { text } }, 'ui')`,
and read `harness.jobs('a')` for what `useJobs()` shows. Give two
harnesses the same `dataRoot` to test two chats sharing a saved document.

Run with `pnpm --filter <canvas> test`.

## Browser tests: `e2e/*.spec.ts`

Test the built UI with Playwright: the same bundle and Content-Security-Policy as
the installed plugin.

```ts
import { canvasTest, expect } from '@rwoll/canvas-kit/playwright'
import canvas from '../server/canvas.ts'

const test = canvasTest(canvas)

test('the user and the agent share the board', async ({ openCanvas, agent }) => {
  const { page, state } = await openCanvas({ repo: 'octo/app' })        // waits until the page is live
  await page.getByLabel('New blocker').fill('CI is red')
  await page.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByRole('checkbox', { name: 'CI is red' })).toBeVisible()

  await agent.invoke('clear_resolved')                                   // act as the agent
  expect(state()?.blockers).toHaveLength(1)
})

test('reports a failed message to the agent', async ({ openCanvas, agent }) => {
  const { page } = await openCanvas({ repo: 'octo/app' })
  agent.failNextSend()
  await page.getByRole('button', { name: 'Ask the agent' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
})
```

Fixtures:

| Fixture | Use it to |
| --- | --- |
| `openCanvas(input?, { instanceId? })` | Open an instance and get `page`, `state()`, and `openAnotherPage()` for a second synced view. |
| `agent` | `invoke(action, input?)` as the agent, read `messages`, and `failNextSend()`. |
| `seed(key, state)` | Save state for a `persist` key before opening, to test reopening. |
| `runJob(id, { key? })` | Run a job now, by name or added job ID, for the latest instance or a saved document. Pass `canvasTest(canvas, { now })` to control the clock. |

`playwright.config.ts` is `export default defineCanvasConfig()`: specs in `e2e/`,
run in light, dark, and high-contrast Chromium.

```sh
pnpm --filter <canvas> build                 # browser tests use the build
pnpm --filter <canvas> playwright:install    # once
pnpm --filter <canvas> e2e
```

## Pitfalls

- UI that shows server state changes after the action's round trip. Use `click()`
  and a web-first assertion (`toBeChecked()`, `toBeVisible()`), not `check()`,
  which fails because the box is still unchecked at the moment of the click.
- Use roles and labels (`getByRole`, `getByLabel`), not CSS selectors.
- Rebuild before `e2e` after UI changes; the tests use `dist/`.
- Vitest ignores `e2e/`; Playwright runs only `e2e/`.
