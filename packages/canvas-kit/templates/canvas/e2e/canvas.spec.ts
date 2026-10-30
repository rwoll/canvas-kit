import { canvasTest, expect } from '@rwoll/canvas-kit/playwright'
import canvas from '../server/canvas.ts'

const test = canvasTest(canvas)

test('the user and the agent share live state', async ({ openCanvas, agent }) => {
  const { page, state } = await openCanvas()

  await page.getByRole('button', { name: 'Count is 0' }).click()
  await expect(page.getByRole('button', { name: 'Count is 1' })).toBeVisible()
  expect(state()).toEqual({ count: 1 })

  await agent.invoke('reset')
  await expect(page.getByRole('button', { name: 'Count is 0' })).toBeVisible()
})
