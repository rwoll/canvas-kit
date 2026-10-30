import { canvasTest, expect } from '@rwoll/canvas-kit/playwright'
import canvas from '../server/canvas.ts'

let now = Date.now()
const test = canvasTest(canvas, { now: () => now })

test('the user and the agent work on the same board', async ({ openCanvas, agent }) => {
  const { page, state } = await openCanvas({ repo: 'octo/app' })
  await expect(page.getByText('octo/app · No open blockers')).toBeVisible()

  await page.getByLabel('New blocker').fill('CI is red on main')
  await page.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByRole('checkbox', { name: 'CI is red on main' })).toBeVisible()
  await expect(page.getByLabel('New blocker')).toHaveValue('')

  // The agent's changes reach the page live.
  await agent.invoke('add_blocker', { text: 'Docs missing' })
  await expect(page.getByText('2 open blockers')).toBeVisible()

  // Checkboxes show server state, so click and wait for the round trip rather than check().
  await page.getByRole('checkbox', { name: 'CI is red on main' }).click()
  await expect(page.getByRole('checkbox', { name: 'CI is red on main' })).toBeChecked()
  await agent.invoke('clear_resolved')
  await expect(page.getByRole('listitem')).toHaveCount(1)
  expect(state()?.blockers).toEqual([{ id: 'b2', text: 'Docs missing', resolved: false }])
})

test('asks the agent and reports when it cannot be reached', async ({ openCanvas, agent }) => {
  const { page } = await openCanvas({ repo: 'octo/app' })
  await agent.invoke('add_blocker', { text: 'Flaky test' })

  await page.getByRole('button', { name: 'Ask the agent to investigate' }).click()
  await expect.poll(() => agent.messages.length).toBe(1)
  expect(agent.messages[0]).toMatchObject({ displayPrompt: 'Release board · 1 blocker' })

  agent.failNextSend()
  await page.getByRole('button', { name: 'Ask the agent to investigate' }).click()
  await expect(page.getByRole('alert')).toContainText('Could not message the agent')
})

test('reopens a saved board and keeps two views in sync', async ({ openCanvas, seed }) => {
  await seed('octo/app', { repo: 'octo/app', blockers: [{ id: 'b1', text: 'Release notes', resolved: false }], nextId: 2 })
  const { page, openAnotherPage } = await openCanvas({ repo: 'octo/app' })
  await expect(page.getByRole('checkbox', { name: 'Release notes' })).not.toBeChecked()

  const other = await openAnotherPage()
  await other.getByRole('checkbox', { name: 'Release notes' }).click()
  await expect(page.getByRole('checkbox', { name: 'Release notes' })).toBeChecked()
})

test('the user and the agent schedule recurring checks', async ({ openCanvas, agent, runJob }) => {
  now = Date.parse('2026-10-01T09:00:00Z')
  const { page } = await openCanvas({ repo: 'octo/app' })
  const checks = page.getByRole('region', { name: 'Recurring checks' })

  await page.getByLabel('New recurring check').fill('Check security sign-off')
  await checks.getByLabel('How often', { exact: true }).selectOption({ label: 'every 1d' })
  await page.getByRole('button', { name: 'Schedule' }).click()
  const row = checks.getByRole('group', { name: 'Check security sign-off' })
  await expect(row).toContainText('Not run yet')
  await expect(row.getByLabel('How often: Check security sign-off')).toHaveValue(String(24 * 60 * 60 * 1000))

  // Its first run adds the blocker.
  const [{ id }] = (await agent.invoke('list_jobs', {})) as { id: string }[]
  await runJob(id)
  await expect(page.getByRole('checkbox', { name: 'Check security sign-off' })).toBeVisible()

  await row.getByRole('button', { name: 'Pause' }).click()
  await expect(row).toContainText('Paused')
  await row.getByRole('button', { name: 'Resume' }).click()
  await expect(row).not.toContainText('Paused')

  // The agent adds one too, and the page shows it live.
  await agent.invoke('add_job', { job: 'recurring_check', input: { text: 'Update the changelog' }, every: '7d' })
  await expect(checks.getByRole('group', { name: 'Update the changelog' })).toContainText('Not run yet')

  await row.getByRole('button', { name: 'Remove' }).click()
  await expect(row).toHaveCount(0)
  await page.getByLabel('New recurring check').fill('x'.repeat(301))
  await page.getByRole('button', { name: 'Schedule' }).click()
  await expect(checks.getByRole('alert')).toBeVisible()
})

test('the agent writes notes that render as Markdown, never as HTML', async ({ openCanvas, agent }) => {
  const { page } = await openCanvas({ repo: 'octo/app' })
  await agent.invoke('set_notes', {
    markdown: [
      '## Before v2.4.0',
      'CI is **red** on `main`; see [run 4182](https://github.com/octo/app/actions/runs/4182).',
      '',
      '- [x] Release notes',
      '- [ ] Security sign-off',
      '',
      '<img src=x onerror=alert(1)> and [a trap](javascript:alert(1))',
    ].join('\n'),
  })
  const notes = page.getByRole('region', { name: 'Notes' })
  await expect(notes.getByRole('heading', { name: 'Before v2.4.0', level: 3 })).toBeVisible()
  await expect(notes.locator('strong')).toHaveText('red')
  await expect(notes.locator('code')).toHaveText('main')
  await expect(notes.getByRole('link', { name: 'run 4182' })).toHaveAttribute('href', 'https://github.com/octo/app/actions/runs/4182')
  await expect(notes.getByRole('checkbox', { name: 'Release notes' })).toBeChecked()
  await expect(notes.getByRole('checkbox', { name: 'Security sign-off' })).not.toBeChecked()
  // Raw HTML and script links stay text.
  await expect(notes.getByText('<img src=x onerror=alert(1)> and [a trap](javascript:alert(1))')).toBeVisible()
  await expect(notes.locator('img')).toHaveCount(0)
  await expect(notes.getByRole('link')).toHaveCount(1)

  await agent.invoke('set_notes', { markdown: '' })
  await expect(notes).toHaveCount(0)
})
