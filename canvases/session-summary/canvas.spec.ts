import { canvasTest, expect } from '@rwoll/canvas-kit/playwright'
import canvas from './canvas.ts'

const T0 = Date.parse('2026-10-01T09:00:00Z')
let now = T0
const test = canvasTest(canvas, { now: () => now })

test.beforeEach(async ({ page }) => {
  now = T0
  await page.clock.setFixedTime(T0)
})

test('the agent writes the summary and the user asks for a new one', async ({ openCanvas, canvasHarness, agent }) => {
  const { page } = await openCanvas()
  await expect(page.getByText('No summary yet')).toBeVisible()

  await canvasHarness.tickJobs()
  await expect(page.getByRole('group', { name: 'Refresh' }).getByRole('status')).toHaveText('Updating…')
  await expect(page.getByText('Waiting for the agent’s first summary…')).toBeVisible()
  expect(agent.messages.map((message) => message.displayPrompt)).toEqual(['Session summary · refresh'])
  expect(agent.messages[0]?.prompt).toContain('instanceId "test"')

  await agent.invoke('update_summary', {
    headline: 'Importer rewrite is in review: https://github.com/octo/widgets/pull/42',
    status: 'working',
    executiveSummary: 'The goal is a **streaming** importer. See `parse()`.',
    running: [{ title: 'CI', detail: 'Waiting on macOS', state: 'waiting' }],
    attention: ['Approve the schema change in https://github.com/octo/widgets/issues/7'],
    next: ['Merge after review'],
  })
  await expect(page.getByText('Importer rewrite is in review')).toBeVisible()
  const link = page.getByRole('link', { name: 'octo/widgets#42' })
  await expect(link).toHaveAttribute('href', 'https://github.com/octo/widgets/pull/42')
  await expect(page.getByRole('region', { name: 'Executive summary' }).locator('strong')).toHaveText('streaming')
  await expect(page.getByRole('region', { name: 'Running' })).toContainText('waitingCI · Waiting on macOS')
  await expect(page.getByRole('region', { name: 'Needs your attention' }).getByRole('link', { name: 'octo/widgets#7' })).toBeVisible()
  await expect(page.getByText('Working · Updated just now')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Refresh' }).getByRole('status')).toHaveText('Next refresh in 10m')

  await page.getByRole('button', { name: 'Refresh now' }).click()
  await expect(page.getByRole('group', { name: 'Refresh' }).getByRole('status')).toHaveText('Updating…')
  expect(agent.messages).toHaveLength(2)

  // The agent works on it but finishes without calling update_summary.
  agent.sessionEvent('assistant.turn_start', {}, T0 + 1_000)
  agent.sessionEvent('session.idle', {}, T0 + 2_000)
  await expect(page.getByRole('alert')).toHaveText('No new summary: the agent finished without updating it.')
})

test('the user retimes and pauses refreshes, and turns off idle skipping', async ({ openCanvas, agent }) => {
  const { page, state } = await openCanvas()
  const settings = page.getByRole('region', { name: 'Refresh settings' })
  await settings.getByLabel('How often to refresh').selectOption({ label: 'every 5m' })
  await expect(settings.getByLabel('How often to refresh')).toHaveValue(String(5 * 60_000))
  await settings.getByRole('button', { name: 'Pause' }).click()
  await expect(page.getByRole('group', { name: 'Refresh' }).getByRole('status')).toHaveText('Auto-refresh off')
  // The box follows the saved setting, so it changes once the server has it.
  const skip = settings.getByRole('checkbox', { name: 'Skip when nothing happened' })
  await skip.click()
  await expect(skip).not.toBeChecked()
  expect(state()?.skipWhenIdle).toBe(false)

  // The agent sees the same settings.
  expect(await agent.invoke('list_jobs', {})).toMatchObject([{ id: 'refresh', enabled: false, every: 5 * 60_000 }])
  await settings.getByRole('button', { name: 'Resume' }).click()
  await expect(settings.getByRole('button', { name: 'Pause' })).toBeVisible()
})

test('a refresh that cannot reach the agent is reported', async ({ openCanvas, agent }) => {
  const { page } = await openCanvas()
  agent.failNextSend(new Error('session closed'))
  await page.getByRole('button', { name: 'Refresh now' }).click()
  await expect(page.getByRole('alert')).toHaveText('Could not ask the agent just now: Could not message the agent: session closed')
})
