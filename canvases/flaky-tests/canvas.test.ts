import { createTestCanvas } from '@rwoll/canvas-kit/testing'
import { afterEach, describe, expect, it } from 'vitest'
import canvas, { KEEP_TRIAGED_MS, worstOpen } from './canvas.ts'

describe('Flaky tests canvas', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(() => close?.())

  it('records, updates, and triages flaky tests', async () => {
    const harness = await createTestCanvas(canvas)
    close = harness.close
    await harness.open('a', { repo: 'octo/app' })
    expect(await harness.invoke('a', 'report_flaky', { name: 'sign-in redirects', failures: 4, runs: 20 })).toEqual({ id: 't1' })
    expect(await harness.invoke('a', 'report_flaky', { name: 'sign-in redirects', failures: 5, runs: 20 })).toEqual({ id: 't1' })
    await harness.invoke('a', 'report_flaky', { name: 'upload resumes', failures: 2, runs: 20 })
    await expect(harness.invoke('a', 'report_flaky', { name: 'x', failures: 3, runs: 2 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(harness.invoke('a', 'report_flaky', { name: 'x', failures: 1, runs: 2 }, 'ui')).rejects.toMatchObject({ code: 'not_found' })
    await harness.invoke('a', 'set_triaged', { id: 't1', triaged: true }, 'ui')
    expect(harness.state('a')?.tests.map((test) => [test.name, test.failures, test.triaged])).toEqual([
      ['sign-in redirects', 5, true],
      ['upload resumes', 2, false],
    ])
  })

  it('prunes tests triaged more than a week ago, hourly', async () => {
    let now = Date.parse('2026-10-01T09:00:00Z')
    const harness = await createTestCanvas(canvas, { now: () => now })
    close = harness.close
    await harness.open('a', { repo: 'octo/app' })
    await harness.invoke('a', 'report_flaky', { name: 'old', failures: 1, runs: 10 })
    await harness.invoke('a', 'report_flaky', { name: 'open', failures: 1, runs: 10 })
    await harness.invoke('a', 'set_triaged', { id: 't1', triaged: true }, 'ui')
    expect(harness.state('a')?.tests[0]?.triagedAt).toBe('2026-10-01T09:00:00.000Z')

    now += KEEP_TRIAGED_MS - 1
    await harness.tickJobs()
    expect(harness.state('a')?.tests).toHaveLength(2)
    now += 60 * 60 * 1000
    await harness.tickJobs()
    expect(harness.state('a')?.tests.map((test) => test.name)).toEqual(['open'])
  })

  it('keeps the agent\'s triage notes, trimmed, and clears them', async () => {
    const harness = await createTestCanvas(canvas)
    close = harness.close
    await harness.open('a', { repo: 'octo/app' })
    expect(harness.state('a')?.notes).toBe('')
    await harness.invoke('a', 'set_notes', { markdown: '  **sign-in redirects** races in `refresh()`\n' })
    expect(harness.state('a')?.notes).toBe('**sign-in redirects** races in `refresh()`')
    await expect(harness.invoke('a', 'set_notes', { markdown: 'x' }, 'ui')).rejects.toMatchObject({ code: 'not_found' })
    await harness.invoke('a', 'set_notes', { markdown: '' })
    expect(harness.state('a')?.notes).toBe('')
  })

  it('asks the agent about the flakiest open test', async () => {
    const harness = await createTestCanvas(canvas)
    close = harness.close
    await harness.open('a', { repo: 'octo/app' })
    await expect(harness.invoke('a', 'ask_to_fix', {}, 'ui')).rejects.toMatchObject({ code: 'nothing_open' })
    await harness.invoke('a', 'report_flaky', { name: 'upload resumes', failures: 2, runs: 20 })
    await harness.invoke('a', 'report_flaky', { name: 'search debounce', failures: 3, runs: 10 })
    await harness.invoke('a', 'ask_to_fix', {}, 'ui')
    expect(harness.sentToAgent.map((message) => message.displayPrompt)).toEqual(['Flaky tests · fix search debounce'])
    expect(worstOpen([{ failures: 1, runs: 2, triaged: true }])).toBeUndefined()
  })
})
