import { Checklist, Header, JobRow, Markdown, TextButton } from '@examples/ui'
import { createCanvasHooks } from '@rwoll/canvas-kit/react'
import type canvas from '../server/canvas.ts'

const { useCanvas, useAction, useJobs } = createCanvasHooks<typeof canvas>()

function App() {
  const { state } = useCanvas()
  const [setTriaged] = useAction('set_triaged')
  const [askToFix, asking] = useAction('ask_to_fix')
  const jobs = useJobs()
  const prune = jobs.jobs.find((job) => job.id === 'prune_triaged')
  const open = state.tests.filter((test) => !test.triaged).length
  // Flakiest first.
  const tests = [...state.tests].sort((a, b) => b.failures / b.runs - a.failures / a.runs)

  return (
    <main>
      <Header title="Flaky tests" meta={`${state.repo} · ${open === 0 ? 'Nothing to triage' : `${open} to triage`}`} />
      <Checklist
        label="Flaky tests"
        items={tests.map((test) => ({ id: test.id, label: test.name, done: test.triaged, note: `${test.failures}/${test.runs} failed` }))}
        onToggle={(id, triaged) => void setTriaged({ id, triaged })}
        empty="No flaky tests reported yet. Ask the agent to look for some."
      />
      {state.notes && <Markdown label="Triage notes">{state.notes}</Markdown>}
      <TextButton disabled={asking.pending || open === 0} onClick={() => void askToFix()}>
        Ask the agent to fix the flakiest one
      </TextButton>
      {asking.error && <p role="alert">{asking.error.message}</p>}

      {prune && (
        <section aria-label="Schedule">
          <JobRow
            job={prune}
            label="Prune tests triaged over a week ago"
            pending={jobs.pending.has(prune.id)}
            onUpdate={(patch) => void jobs.update(prune.id, patch)}
            onRun={() => void jobs.run(prune.id)}
          />
          {jobs.error && <p role="alert">{jobs.error.message}</p>}
        </section>
      )}
    </main>
  )
}

export default App
