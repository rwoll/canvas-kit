import { fileURLToPath } from 'node:url'
import { canvasTest } from '@rwoll/canvas-kit/playwright'
import canvas from '../server/canvas.ts'

const test = canvasTest(canvas, { now: () => Date.parse('2026-10-01T16:00:00Z') })

// Updates the screenshots in the repository README: UPDATE_SCREENSHOTS=1 pnpm e2e --project light --project dark
test('README screenshot', async ({ openCanvas, agent, runJob }, testInfo) => {
  test.skip(!process.env.UPDATE_SCREENSHOTS, 'set UPDATE_SCREENSHOTS=1 to update the README screenshots')
  const { page } = await openCanvas({ repo: 'octo/app' })
  await page.setViewportSize({ width: 720, height: 540 })
  await agent.invoke('report_flaky', { name: 'sign-in redirects', failures: 4, runs: 20 })
  await agent.invoke('report_flaky', { name: 'upload resumes', failures: 2, runs: 20 })
  const { id } = await agent.invoke('report_flaky', { name: 'search debounce', failures: 1, runs: 20 })
  await agent.invoke('set_triaged', { id, triaged: true })
  await runJob('prune_triaged')
  await agent.invoke('set_notes', { markdown: '**sign-in redirects** fails when `SESSION_TTL` is under 5s, likely a race in `refresh()`.' })
  await page.getByRole('checkbox', { name: 'search debounce' }).waitFor()
  const file = fileURLToPath(new URL(`../../../docs/flaky-tests-${testInfo.project.name}.png`, import.meta.url))
  await page.screenshot({ path: file })
})
