import type { JobStatus } from '@rwoll/canvas-kit/react'
import { IntervalSelect } from './IntervalSelect.tsx'
import { TextButton } from './TextButton.tsx'

export interface JobRowProps {
  /** A job from `useJobs().jobs`. */
  job: JobStatus
  /** What it does, in a few words, such as "Prune triaged tests". */
  label: string
  /** Pause, resume, or retime it. Without it, the row is read-only. */
  onUpdate?: (patch: { enabled?: boolean; every?: number }) => void
  onRun?: () => void
  /** For jobs added from a job with input. */
  onRemove?: () => void
  pending?: boolean
}

const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function describe(job: JobStatus): string {
  const last = job.lastRunAt ? `Last ran ${when(job.lastRunAt)}` : 'Not run yet'
  if (!job.enabled) return `Paused · ${last}`
  if (job.lastError) return `Last run failed: ${job.lastError}`
  return job.nextRunAt ? `${last} · next ${when(job.nextRunAt)}` : last
}

/** One scheduled job: what it does, how often, its last run, and controls. */
export function JobRow({ job, label, onUpdate, onRun, onRemove, pending }: JobRowProps) {
  return (
    <div className="ui-job" role="group" aria-label={label}>
      <div className="ui-job-main">
        <span className="ui-job-label">{label}</span>
        {onUpdate ? (
          <IntervalSelect
            label={`How often: ${label}`}
            value={job.every}
            min={job.minEvery}
            max={job.maxEvery}
            disabled={pending}
            onChange={(every) => onUpdate({ every })}
          />
        ) : null}
        {onUpdate && (
          <TextButton disabled={pending} onClick={() => onUpdate({ enabled: !job.enabled })}>
            {job.enabled ? 'Pause' : 'Resume'}
          </TextButton>
        )}
        {onRun && (
          <TextButton disabled={pending} onClick={onRun}>
            Run now
          </TextButton>
        )}
        {onRemove && (
          <TextButton disabled={pending} onClick={onRemove}>
            Remove
          </TextButton>
        )}
      </div>
      <p className={job.lastError && job.enabled ? 'ui-job-status error' : 'ui-job-status'}>{describe(job)}</p>
    </div>
  )
}
