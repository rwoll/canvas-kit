import { createTestCanvas } from '@rwoll/canvas-kit/testing'
import { afterEach, describe, expect, it } from 'vitest'
import canvas from './canvas.ts'

describe('Release board canvas', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(() => close?.())

  it('adds, resolves, and clears blockers, and keeps one board per repository', async () => {
    const harness = await createTestCanvas(canvas)
    close = harness.close
    await harness.open('a', { repo: 'octo/app' })
    expect(await harness.invoke('a', 'add_blocker', { text: '  CI is red  ' }, 'ui')).toEqual({ id: 'b1' })
    await harness.invoke('a', 'add_blocker', { text: 'Docs missing' })
    await harness.invoke('a', 'set_resolved', { id: 'b1', resolved: true }, 'ui')
    await harness.invoke('a', 'clear_resolved')
    expect(harness.state('a')?.blockers).toEqual([{ id: 'b2', text: 'Docs missing', resolved: false }])
    await expect(harness.invoke('a', 'set_resolved', { id: 'b9', resolved: true })).rejects.toMatchObject({ code: 'not_found' })

    // Another instance for the same repository shares the saved board; another repository starts empty.
    await harness.open('b', { repo: 'octo/app' })
    expect(harness.state('b')?.blockers).toHaveLength(1)
    await harness.open('c', { repo: 'octo/other' })
    expect(harness.state('c')?.blockers).toEqual([])
  })

  it('adds each recurring check as a blocker on its schedule, unless it is already open', async () => {
    let now = Date.parse('2026-10-01T09:00:00Z')
    const harness = await createTestCanvas(canvas, { now: () => now })
    close = harness.close
    await harness.open('a', { repo: 'octo/app' })
    const check = (await harness.invoke('a', 'add_job', { job: 'recurring_check', input: { text: 'Check security sign-off' }, every: '1d' }, 'ui')) as { id: string }
    await harness.tickJobs()
    expect(harness.state('a')?.blockers).toEqual([{ id: 'b1', text: 'Check security sign-off', resolved: false }])

    // Still open a day later: not added again.
    now += 24 * 60 * 60 * 1000
    await harness.tickJobs()
    expect(harness.state('a')?.blockers).toHaveLength(1)
    // Resolved: added again on the next run.
    await harness.invoke('a', 'set_resolved', { id: 'b1', resolved: true }, 'ui')
    now += 24 * 60 * 60 * 1000
    await harness.tickJobs()
    expect(harness.state('a')?.blockers.map((entry) => [entry.id, entry.resolved])).toEqual([['b1', true], ['b2', false]])

    // The agent can see and manage recurring checks too.
    expect(await harness.invoke('a', 'list_jobs', {})).toMatchObject([{ id: check.id, job: 'recurring_check', input: { text: 'Check security sign-off' } }])
    await harness.invoke('a', 'remove_job', { id: check.id })
    expect(harness.jobs('a')).toEqual([])
  })

  it('asks the agent about open blockers only', async () => {
    const harness = await createTestCanvas(canvas)
    close = harness.close
    await harness.open('a', { repo: 'octo/app' })
    await expect(harness.invoke('a', 'ask_agent', {}, 'ui')).rejects.toMatchObject({ code: 'nothing_open' })
    await harness.invoke('a', 'add_blocker', { text: 'CI is red' })
    await harness.invoke('a', 'ask_agent', {}, 'ui')
    expect(harness.sentToAgent).toEqual([
      { prompt: 'Investigate these release blockers for octo/app and report back:\n- CI is red', displayPrompt: 'Release board · 1 blocker' },
    ])
  })
})
