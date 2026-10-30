import { canvasTest, expect } from '@rwoll/canvas-kit/playwright'
import canvas, { KEEP_TRIAGED_MS } from '../server/canvas.ts'

let now = Date.now()
const test = canvasTest(canvas, { now: () => now })

test('the agent reports flaky tests and the user triages them', async ({ openCanvas, agent }) => {
  const { page } = await openCanvas({ repo: 'octo/app' })
  await expect(page.getByText('No flaky tests reported yet')).toBeVisible()

  await agent.invoke('report_flaky', { name: 'upload resumes', failures: 2, runs: 20 })
  await agent.invoke('report_flaky', { name: 'sign-in redirects', failures: 4, runs: 20 })
  // Flakiest first, with its failure rate.
  await expect(page.getByRole('listitem').first()).toContainText('sign-in redirects4/20 failed')
  await expect(page.getByText('octo/app · 2 to triage')).toBeVisible()

  await page.getByRole('checkbox', { name: 'sign-in redirects' }).click()
  await expect(page.getByRole('checkbox', { name: 'sign-in redirects' })).toBeChecked()
  await expect(page.getByText('octo/app · 1 to triage')).toBeVisible()

  await page.getByRole('button', { name: 'Ask the agent to fix the flakiest one' }).click()
  await expect.poll(() => agent.messages.map((message) => message.displayPrompt)).toEqual(['Flaky tests · fix upload resumes'])
})

test('a week after triage, the hourly job prunes the test', async ({ openCanvas, agent, runJob }) => {
  now = Date.parse('2026-10-01T09:00:00Z')
  const { page } = await openCanvas({ repo: 'octo/app' })
  await agent.invoke('report_flaky', { name: 'upload resumes', failures: 2, runs: 20 })
  await agent.invoke('report_flaky', { name: 'sign-in redirects', failures: 4, runs: 20 })
  await page.getByRole('checkbox', { name: 'sign-in redirects' }).click()
  await expect(page.getByRole('checkbox', { name: 'sign-in redirects' })).toBeChecked()

  now += KEEP_TRIAGED_MS + 1
  expect(await runJob('prune_triaged')).toMatchObject({ ran: true })
  await expect(page.getByRole('checkbox', { name: 'sign-in redirects' })).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: 'upload resumes' })).toBeVisible()
})

test('the user pauses, retimes, and runs the prune job', async ({ openCanvas, agent }) => {
  now = Date.parse('2026-10-01T09:00:00Z')
  const { page } = await openCanvas({ repo: 'octo/app' })
  const prune = page.getByRole('group', { name: 'Prune tests triaged over a week ago' })
  await expect(prune).toContainText('Not run yet')

  await prune.getByRole('button', { name: 'Run now' }).click()
  await expect(prune).toContainText('Last ran')
  await prune.getByLabel('How often: Prune tests triaged over a week ago').selectOption({ label: 'every 6h' })
  await expect(prune.getByLabel('How often: Prune tests triaged over a week ago')).toHaveValue(String(6 * 60 * 60 * 1000))
  await prune.getByRole('button', { name: 'Pause' }).click()
  await expect(prune).toContainText('Paused')

  // The agent sees the same settings.
  expect(await agent.invoke('list_jobs', {})).toMatchObject([{ id: 'prune_triaged', enabled: false, every: 6 * 60 * 60 * 1000 }])
})
