import { fileURLToPath } from 'node:url'
import { canvasTest } from '@rwoll/canvas-kit/playwright'
import canvas from '../server/canvas.ts'

const test = canvasTest(canvas, { now: () => Date.parse('2026-10-01T16:00:00Z') })

// Updates the screenshots in the repository README: UPDATE_SCREENSHOTS=1 pnpm e2e --project light --project dark
test('README screenshot', async ({ openCanvas, agent, runJob }, testInfo) => {
  test.skip(!process.env.UPDATE_SCREENSHOTS, 'set UPDATE_SCREENSHOTS=1 to update the README screenshots')
  const { page } = await openCanvas({ repo: 'octo/app' })
  await page.setViewportSize({ width: 720, height: 660 })
  for (const text of ['CI is red on main', 'Release notes are missing', 'Flaky sign-in test']) {
    await agent.invoke('add_blocker', { text })
  }
  await agent.invoke('set_resolved', { id: 'b2', resolved: true })
  await agent.invoke('set_notes', { markdown: '**v2.4.0** ships once CI is green on `main`. Release notes are [drafted](https://github.com/octo/app/releases).' })
  const check = (await agent.invoke('add_job', { job: 'recurring_check', input: { text: 'Check security sign-off' }, every: '7d' })) as { id: string }
  await runJob(check.id)
  await agent.invoke('set_resolved', { id: 'b4', resolved: true })
  await page.getByRole('checkbox', { name: 'Release notes are missing' }).waitFor()
  const file = fileURLToPath(new URL(`../../../docs/release-board-${testInfo.project.name}.png`, import.meta.url))
  await page.screenshot({ path: file })
})
