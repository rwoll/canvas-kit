import { createTestCanvas } from '@rwoll/canvas-kit/testing'
import { afterEach, describe, expect, it } from 'vitest'
import canvas from './canvas.ts'

describe('__TITLE__ canvas', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(() => close?.())

  it('counts and resets', async () => {
    const harness = await createTestCanvas(canvas)
    close = harness.close
    await harness.open('test')
    expect(harness.state('test')).toEqual({ count: 0 })

    await harness.invoke('test', 'increment', { by: 2 })
    await harness.invoke('test', 'increment', {}, 'ui')
    expect(harness.state('test')).toEqual({ count: 3 })

    await harness.invoke('test', 'reset')
    expect(await harness.invoke('test', 'get_state')).toEqual({ count: 0 })
  })
})
