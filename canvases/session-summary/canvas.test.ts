import { createTestCanvas, type TestCanvas } from '@rwoll/canvas-kit/testing'
import { afterEach, describe, expect, it } from 'vitest'
import canvas, { DEBOUNCE_MS, EXPIRE_MS, refreshPrompt, settle } from './canvas.ts'

const T0 = Date.parse('2026-10-01T09:00:00Z')
const MINUTE = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
const SUMMARY = { headline: 'Shipping the importer', status: 'working' as const }

describe('Session summary canvas', () => {
  let harness: TestCanvas<typeof canvas> | undefined
  let now = T0
  afterEach(async () => {
    await harness?.close()
    harness = undefined
    now = T0
  })

  async function open(options: { sessionId?: string; dataRoot?: string } = {}) {
    harness = await createTestCanvas(canvas, { now: () => now, ...options })
    await harness.open('summary')
    return harness
  }

  it('asks for the first summary when it opens, then shows what the agent writes', async () => {
    const h = await open()
    await h.tickJobs()
    expect(h.sentToAgent).toEqual([{ prompt: refreshPrompt('summary', 'schedule'), displayPrompt: 'Session summary · refresh', mode: 'immediate' }])
    expect(h.state('summary')?.pending).toEqual({ trigger: 'schedule', requestedAt: iso(T0) })

    now += 20_000
    const result = await h.invoke('summary', 'update_summary', {
      ...SUMMARY,
      executiveSummary: '\n\n  Indented **goal**.\r\nNext line.  \n',
      running: ['Parser rewrite', { title: 'CI', detail: 'Waiting on macOS', state: 'waiting' }],
      attention: ['Approve the schema change'],
    })
    expect(result).toEqual({ revision: 1, updatedAt: iso(T0 + 20_000) })
    expect(h.state('summary')).toMatchObject({
      pending: null,
      summary: {
        executiveSummary: '  Indented **goal**.\nNext line.',
        running: [
          { title: 'Parser rewrite', detail: '', state: 'running' },
          { title: 'CI', detail: 'Waiting on macOS', state: 'waiting' },
        ],
        attention: ['Approve the schema change'],
        progress: [],
        next: [],
        notes: '',
      },
    })
    expect(canvas.status(h.state('summary'))).toBe('Shipping the importer')
  })

  it('rejects summaries the canvas cannot show, with messages the agent can act on', async () => {
    const h = await open()
    await expect(h.invoke('summary', 'update_summary', { ...SUMMARY, extra: 1 } as never)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(h.invoke('summary', 'update_summary', { ...SUMMARY, headline: ' ' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(h.invoke('summary', 'update_summary', { ...SUMMARY, attention: Array(9).fill('x') })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(h.invoke('summary', 'update_summary', { ...SUMMARY, executiveSummary: 'x'.repeat(4001) })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(h.invoke('summary', 'update_summary', SUMMARY, 'ui')).rejects.toMatchObject({ code: 'not_found' })
    expect(h.state('summary')?.summary).toBeNull()
  })

  it('skips a scheduled refresh while nothing has happened, and asks once the agent works', async () => {
    const h = await open()
    await h.tickJobs()
    await h.invoke('summary', 'update_summary', SUMMARY)
    // Calling canvas tools is not new work.
    h.sessionEvent('tool.execution_start', { toolCallId: 'a', toolName: 'invoke_canvas_action' })
    h.sessionEvent('session.idle')

    now += 10 * MINUTE
    await h.tickJobs()
    expect(h.sentToAgent).toHaveLength(1)
    expect(h.state('summary')?.lastOutcome).toEqual({ kind: 'skipped', at: iso(now), detail: 'Nothing happened since the last summary.' })

    h.sessionEvent('tool.execution_start', { toolCallId: 'b', toolName: 'edit' })
    h.sessionEvent('session.idle')
    now += 10 * MINUTE
    await h.tickJobs()
    expect(h.sentToAgent).toHaveLength(2)
    expect(h.state('summary')?.pending).toEqual({ trigger: 'schedule', requestedAt: iso(now) })
  })

  it('refreshes while the agent is busy, and always when skipping is off', async () => {
    const h = await open()
    await h.invoke('summary', 'update_summary', SUMMARY)
    await h.tickJobs()
    h.sessionEvent('assistant.turn_start')
    now += 10 * MINUTE
    await h.tickJobs()
    expect(h.sentToAgent).toHaveLength(1)

    await h.invoke('summary', 'update_summary', SUMMARY)
    h.sessionEvent('session.idle')
    await h.invoke('summary', 'set_skip_when_idle', { enabled: false }, 'ui')
    now += 10 * MINUTE
    await h.tickJobs()
    expect(h.sentToAgent).toHaveLength(2)
  })

  it('waits for a summary the agent wrote on its own recently', async () => {
    const h = await open()
    await h.tickJobs()
    await h.invoke('summary', 'update_summary', SUMMARY)
    h.sessionEvent('tool.execution_start', { toolCallId: 'a', toolName: 'bash' })
    now += 8 * MINUTE
    await h.invoke('summary', 'update_summary', SUMMARY)
    now += 2 * MINUTE
    await h.tickJobs()
    expect(h.sentToAgent).toHaveLength(1)
    expect(h.state('summary')?.lastOutcome).toBeNull()
  })

  it('waits for an outstanding request, then reports it unanswered once the agent stops', async () => {
    const h = await open()
    await h.tickJobs()
    h.sessionEvent('assistant.turn_start')
    now += 10 * MINUTE
    await h.tickJobs()
    expect(h.sentToAgent).toHaveLength(1)

    h.sessionEvent('session.idle')
    now += 10 * MINUTE
    await h.tickJobs()
    // The agent finished without answering; there is still no summary, so it asks again.
    expect(h.state('summary')?.lastOutcome).toMatchObject({ kind: 'unanswered' })
    expect(h.sentToAgent).toHaveLength(2)
  })

  it('drops a request the agent never picked up', () => {
    const request = { trigger: 'schedule' as const, requestedAt: iso(T0) }
    expect(settle(request, { busy: false }, T0 + EXPIRE_MS - 1)).toBeUndefined()
    expect(settle(request, { busy: true }, T0 + EXPIRE_MS)).toBeUndefined()
    expect(settle(request, { busy: false }, T0 + EXPIRE_MS)).toEqual({
      kind: 'expired',
      at: iso(T0 + EXPIRE_MS),
      detail: 'The agent did not pick up the request.',
    })
    expect(settle(request, { busy: false, idleSince: T0 - 1 }, T0 + 1)).toBeUndefined()
    expect(settle(request, { busy: false, idleSince: T0 + 1 }, T0 + 2)).toMatchObject({ kind: 'unanswered' })
  })

  it('refreshes on request, even when idle, once per double click, replacing a scheduled request', async () => {
    const h = await open()
    await h.tickJobs()
    h.sessionEvent('assistant.turn_start')
    await h.invoke('summary', 'run_job', { id: 'refresh' }, 'ui')
    expect(h.state('summary')?.pending).toEqual({ trigger: 'manual', requestedAt: iso(T0) })
    now += DEBOUNCE_MS - 1
    await h.invoke('summary', 'run_job', { id: 'refresh' }, 'ui')
    expect(h.sentToAgent.map((message) => message.prompt)).toEqual([refreshPrompt('summary', 'schedule'), refreshPrompt('summary', 'manual')])

    await h.invoke('summary', 'update_summary', SUMMARY)
    h.sessionEvent('session.idle')
    now += 1
    await h.invoke('summary', 'run_job', { id: 'refresh' }, 'ui')
    expect(h.sentToAgent).toHaveLength(3)
  })

  it('reports a refresh that could not reach the agent', async () => {
    harness = await createTestCanvas(canvas, {
      now: () => now,
      sendToAgent: async () => {
        throw new Error('session closed')
      },
    })
    await harness.open('summary')
    await harness.tickJobs()
    expect(harness.state('summary')).toMatchObject({
      pending: null,
      lastOutcome: { kind: 'send_failed', detail: 'Could not message the agent: session closed' },
    })
  })

  it('skips its work under canvas-kit run, with no chat open', async () => {
    const h = await open({ sessionId: 'chat-a' })
    const headless = await createTestCanvas(canvas, { now: () => now, dataRoot: h.dataRoot })
    expect(await headless.runJob('refresh', { key: 'chat-a', headless: true })).toMatchObject({ ran: true })
    expect(headless.sentToAgent).toEqual([])
    await headless.close()
  })

  it('keeps one summary per chat, and lets the agent pause refreshes', async () => {
    const first = await open({ sessionId: 'chat-a' })
    await first.invoke('summary', 'update_summary', SUMMARY)
    await first.invoke('summary', 'update_job', { id: 'refresh', enabled: false })
    expect(first.jobs('summary')).toMatchObject([{ id: 'refresh', enabled: false, every: 10 * MINUTE }])
    now += 60 * MINUTE
    await first.tickJobs()
    expect(first.sentToAgent).toEqual([])

    const second = await createTestCanvas(canvas, { now: () => now, sessionId: 'chat-b', dataRoot: first.dataRoot })
    await second.open('summary')
    expect(second.state('summary')?.summary).toBeNull()
    await second.close()

    const again = await createTestCanvas(canvas, { now: () => now, sessionId: 'chat-a', dataRoot: first.dataRoot })
    await again.open('other')
    expect(again.state('other')?.summary?.headline).toBe('Shipping the importer')
    await again.close()
  })
})
