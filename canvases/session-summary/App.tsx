import { Header, InlineMarkdown, IntervalSelect, Markdown, TextButton } from '../../ui'
import { createCanvasHooks, type AgentActivity } from '@rwoll/canvas-kit/react'
import { useEffect, useState } from 'react'
import type canvas from './canvas.ts'
import type { PendingRefresh, RefreshOutcome, Summary } from './canvas.ts'
import { linkReferences } from './references.ts'
import '../../ui/theme.css'
import './App.css'

const { useCanvas, useAction, useJobs } = createCanvasHooks<typeof canvas>()

const STATUS_LABELS: Record<Summary['status'], string> = {
  working: 'Working',
  waiting: 'Waiting',
  blocked: 'Blocked',
  idle: 'Idle',
  done: 'Done',
}

const INTERVALS = ['1m', '5m', '10m', '15m', '30m', '1h', '2h', '6h', '12h', '1d'] as const

const OUTCOMES: Record<RefreshOutcome['kind'], string> = {
  skipped: 'Skipped a refresh',
  unanswered: 'No new summary',
  expired: 'No new summary',
  send_failed: 'Could not ask the agent',
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1_000))}s`
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}

const ago = (iso: string, now: number) => (now - Date.parse(iso) < 45_000 ? 'just now' : `${duration(now - Date.parse(iso))} ago`)

/** The agent finished a turn after the request without answering it. */
function unanswered(pending: PendingRefresh | null, agent: AgentActivity): boolean {
  return !!pending && !agent.busy && agent.idleSince !== undefined && agent.idleSince > Date.parse(pending.requestedAt)
}

function App() {
  const { state, agent } = useCanvas()
  const jobs = useJobs()
  const [setSkip, skipping] = useAction('set_skip_when_idle')
  const now = useNow()
  const refresh = jobs.jobs.find((job) => job.id === 'refresh')
  const { summary, pending, lastOutcome } = state
  const stalled = unanswered(pending, agent)
  const updating = !!pending && !stalled

  let schedule = ''
  if (updating) schedule = 'Updating…'
  else if (refresh && !refresh.enabled) schedule = 'Auto-refresh off'
  else if (refresh?.nextRunAt) {
    const left = Date.parse(refresh.nextRunAt) - now
    schedule = left > 0 ? `Next refresh in ${duration(left)}` : 'Refresh due'
  }

  // Report only what happened after the summary on screen.
  const outcome = lastOutcome && (!summary || lastOutcome.at > summary.updatedAt) ? lastOutcome : undefined
  const notice = stalled
    ? { error: true, text: 'No new summary: the agent finished without updating it.' }
    : outcome && { error: outcome.kind !== 'skipped', text: `${OUTCOMES[outcome.kind]} ${ago(outcome.at, now)}: ${outcome.detail}` }

  return (
    <main>
      <div className="top">
        <Header
          title="Session summary"
          meta={
            summary ? (
              <>
                <span className={`status status-${summary.status}`}>{STATUS_LABELS[summary.status]}</span> · Updated {ago(summary.updatedAt, now)}
              </>
            ) : (
              'No summary yet'
            )
          }
        />
        <div className="refresh" role="group" aria-label="Refresh">
          <span className={updating ? 'schedule updating' : 'schedule'} role="status">
            {schedule}
          </span>
          <TextButton disabled={jobs.pending.has('refresh')} onClick={() => void jobs.run('refresh')}>
            Refresh now
          </TextButton>
        </div>
      </div>

      {notice && (
        <p className={notice.error ? 'notice error' : 'notice'} role={notice.error ? 'alert' : 'status'}>
          {notice.text}
        </p>
      )}

      {summary ? (
        <SummaryView summary={summary} />
      ) : (
        <p className="ui-empty">{updating ? 'Waiting for the agent’s first summary…' : 'Refresh to ask the agent for a summary of this chat.'}</p>
      )}

      {refresh && (
        <section className="settings" aria-label="Refresh settings">
          <span>Ask the agent for a new summary</span>
          <IntervalSelect
            label="How often to refresh"
            value={refresh.every}
            min={refresh.minEvery}
            max={refresh.maxEvery}
            choices={INTERVALS}
            disabled={jobs.pending.has('refresh')}
            onChange={(every) => void jobs.update('refresh', { every })}
          />
          <TextButton disabled={jobs.pending.has('refresh')} onClick={() => void jobs.update('refresh', { enabled: !refresh.enabled })}>
            {refresh.enabled ? 'Pause' : 'Resume'}
          </TextButton>
          <label className="skip">
            <input
              type="checkbox"
              checked={state.skipWhenIdle}
              disabled={skipping.pending}
              onChange={(event) => void setSkip({ enabled: event.target.checked })}
            />
            Skip when nothing happened
          </label>
        </section>
      )}
      {jobs.error && <p role="alert">{jobs.error.message}</p>}
      {skipping.error && <p role="alert">{skipping.error.message}</p>}
    </main>
  )
}

function SummaryView({ summary }: { summary: Summary }) {
  return (
    <>
      <p className="headline">
        <InlineMarkdown>{linkReferences(summary.headline)}</InlineMarkdown>
      </p>
      {summary.executiveSummary && (
        <div className="executive">
          <Markdown label="Executive summary">{linkReferences(summary.executiveSummary)}</Markdown>
        </div>
      )}
      {summary.running.length > 0 && (
        <section aria-label="Running">
          <h2>Running</h2>
          <ul className="items">
            {summary.running.map((item, index) => (
              <li key={index}>
                <span className={`state state-${item.state}`}>{item.state}</span>
                <span>
                  <InlineMarkdown>{linkReferences(item.title)}</InlineMarkdown>
                  {item.detail && (
                    <span className="detail">
                      {' · '}
                      <InlineMarkdown>{linkReferences(item.detail)}</InlineMarkdown>
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <List title="Needs your attention" items={summary.attention} className="attention" />
      <List title="Progress" items={summary.progress} />
      <List title="Next" items={summary.next} />
      {summary.notes && (
        <section aria-label="Notes">
          <h2>Notes</h2>
          <Markdown>{linkReferences(summary.notes)}</Markdown>
        </section>
      )}
    </>
  )
}

function List({ title, items, className }: { title: string; items: readonly string[]; className?: string }) {
  if (items.length === 0) return null
  return (
    <section aria-label={title} className={className}>
      <h2>{title}</h2>
      <ul className="items">
        {items.map((item, index) => (
          <li key={index}>
            <InlineMarkdown>{linkReferences(item)}</InlineMarkdown>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default App
