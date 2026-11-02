import { formatInterval, intervalMs, type Interval } from '@rwoll/canvas-kit/react'

const CHOICES: readonly Interval[] = ['15m', '30m', '1h', '6h', '12h', '1d', '7d', '30d']

export interface IntervalSelectProps {
  /** Accessible name, such as "How often". */
  label: string
  /** The interval in milliseconds. */
  value: number
  /** The shortest and longest choices, in milliseconds, from the job's status or definition. */
  min: number
  max: number
  onChange: (ms: number) => void
  disabled?: boolean
  /** The intervals to offer, within the limits. Defaults to 15 minutes through 30 days. */
  choices?: readonly Interval[]
}

/** Common intervals between a job's limits, plus its current one. */
export function IntervalSelect({ label, value, min, max, onChange, disabled, choices: offered = CHOICES }: IntervalSelectProps) {
  const choices = [...new Set([...offered.map(intervalMs), value])].filter((ms) => ms >= min && ms <= max).sort((a, b) => a - b)
  return (
    <select className="ui-interval" aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))}>
      {choices.map((ms) => (
        <option key={ms} value={ms}>
          every {formatInterval(ms)}
        </option>
      ))}
    </select>
  )
}
