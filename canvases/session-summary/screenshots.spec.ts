import { fileURLToPath } from 'node:url'
import { canvasTest } from '@rwoll/canvas-kit/playwright'
import canvas from './canvas.ts'

const T0 = Date.parse('2026-10-01T16:00:00Z')
const test = canvasTest(canvas, { now: () => T0 })

// Updates the screenshots in the repository README: UPDATE_SCREENSHOTS=1 pnpm e2e screenshots --project light --project dark
test('README screenshot', async ({ openCanvas, canvasHarness, agent, page }, testInfo) => {
  test.skip(!process.env.UPDATE_SCREENSHOTS, 'set UPDATE_SCREENSHOTS=1 to update the README screenshots')
  await page.clock.setFixedTime(T0 + 3 * 60_000)
  await openCanvas()
  await page.setViewportSize({ width: 720, height: 700 })
  await canvasHarness.tickJobs()
  await agent.invoke('update_summary', {
    headline: 'Streaming importer is in review: https://github.com/octo/widgets/pull/42',
    status: 'working',
    executiveSummary:
      'The goal is to import large CSV files without loading them into memory. The streaming parser passes every test, and **memory stays under 50 MB** on the 2 GB fixture. The open question is whether to keep the old API for a release; the next milestone is merging after review.',
    running: [
      { title: 'CI on the pull request', detail: 'macOS job queued', state: 'queued' },
      { title: 'Benchmark against the old importer', state: 'running' },
    ],
    attention: ['Decide whether `importAll()` stays for one more release'],
    progress: ['Rewrote the parser as a stream; all 214 tests pass', 'Fixed the quoting bug from https://github.com/octo/widgets/issues/7'],
    next: ['Address review comments', 'Update the migration guide'],
  })
  await page.getByText('Streaming importer is in review').waitFor()
  const file = fileURLToPath(new URL(`../../docs/session-summary-${testInfo.project.name}.png`, import.meta.url))
  await page.screenshot({ path: file })
})
