import { useState, type FormEvent } from 'react'
import { Checklist, Header, IntervalSelect, JobRow, Markdown, TextButton } from '@examples/ui'
import { createCanvasHooks } from '@rwoll/canvas-kit/react'
import type canvas from '../server/canvas.ts'
import './App.css'

const { useCanvas, useAction, useJobs } = createCanvasHooks<typeof canvas>()

function App() {
  const { state, status } = useCanvas()
  const [addBlocker, adding] = useAction('add_blocker')
  const [setResolved] = useAction('set_resolved')
  const [askAgent, asking] = useAction('ask_agent')
  const [text, setText] = useState('')
  const open = state.blockers.filter((entry) => !entry.resolved).length
  const jobs = useJobs()
  const recurring = jobs.definitions.find((definition) => definition.name === 'recurring_check')
  const [check, setCheck] = useState('')
  const [every, setEvery] = useState(recurring?.every ?? 0)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (await addBlocker({ text })) setText('')
  }

  const addCheck = async (event: FormEvent) => {
    event.preventDefault()
    if (await jobs.add('recurring_check', { text: check }, { every })) setCheck('')
  }

  return (
    <main>
      <Header title="Release board" meta={`${state.repo} · ${open === 0 ? 'No open blockers' : `${open} open blocker${open === 1 ? '' : 's'}`}`} />
      {state.notes && <Markdown label="Notes">{state.notes}</Markdown>}

      <form onSubmit={submit}>
        <label htmlFor="blocker">New blocker</label>
        <input id="blocker" value={text} onChange={(event) => setText(event.target.value)} placeholder="CI is red on main" />
        <button type="submit" disabled={adding.pending || !text.trim()}>
          Add
        </button>
      </form>
      {adding.error && <p role="alert">{adding.error.message}</p>}

      <Checklist
        label="Blockers"
        items={state.blockers.map((entry) => ({ id: entry.id, label: entry.text, done: entry.resolved }))}
        onToggle={(id, resolved) => void setResolved({ id, resolved })}
        empty="No blockers yet."
      />

      <TextButton disabled={asking.pending || open === 0} onClick={() => void askAgent()}>
        Ask the agent to investigate
      </TextButton>
      {asking.error && <p role="alert">{asking.error.message}</p>}

      {recurring && (
        <section aria-labelledby="recurring">
          <h2 id="recurring">Recurring checks</h2>
          {jobs.jobs
            .filter((job) => job.job === 'recurring_check' && job.input)
            .map((job) => (
              <JobRow
                key={job.id}
                job={job}
                label={job.input?.text ?? job.id}
                pending={jobs.pending.has(job.id)}
                onUpdate={(patch) => void jobs.update(job.id, patch)}
                onRemove={() => void jobs.remove(job.id)}
              />
            ))}
          <form onSubmit={addCheck}>
            <label htmlFor="check">New recurring check</label>
            <input id="check" value={check} onChange={(event) => setCheck(event.target.value)} placeholder="Check security sign-off" />
            <IntervalSelect label="How often" value={every} min={recurring.minEvery} max={recurring.maxEvery} onChange={setEvery} />
            <button type="submit" disabled={jobs.pending.has('recurring_check') || !check.trim()}>
              Schedule
            </button>
          </form>
          {jobs.error && <p role="alert">{jobs.error.message}</p>}
        </section>
      )}

      <p className="connection" role="status">
        {status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline'}
      </p>
    </main>
  )
}

export default App
