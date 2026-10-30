// Job types and helpers shared by the server and the browser. No Node.js or Zod imports.

/** A duration such as `30s`, `15m`, `6h`, or `1d`, or milliseconds. */
export type Interval = number | `${number}${'s' | 'm' | 'h' | 'd'}`;

/** Who may pause, resume, retime, and run a job, and add jobs from a job with input. */
export type JobControls = 'both' | 'ui' | 'agent';

export const INTERVAL_PATTERN = /^(\d+(?:\.\d+)?)(s|m|h|d)$/;
const UNITS = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1_000],
] as const;

/** Milliseconds in an `Interval`, or NaN when it is not one. */
export function intervalMs(every: Interval): number {
  if (typeof every === 'number') return every;
  const match = INTERVAL_PATTERN.exec(every);
  const unit = match && UNITS.find(([name]) => name === match[2]);
  return match && unit ? Number(match[1]) * unit[1] : Number.NaN;
}

/** The shortest `Interval` for a duration: `90_000` is `90s`, `3_600_000` is `1h`. */
export function formatInterval(ms: number): Interval {
  for (const [name, size] of UNITS) {
    if (ms >= size && ms % size === 0) return `${ms / size}${name}` as Interval;
  }
  return ms;
}

/** A job's schedule for one document, as the UI and the agent see it. */
export interface JobStatus<Name extends string = string, Input = unknown> {
  /** The job's name for a job without input; otherwise a generated ID such as `remind-3f9a2c`. */
  id: string;
  job: Name;
  description?: string;
  /** The input it was added with, for a job added from a job with input. */
  input?: Input;
  /** Interval in milliseconds; `formatInterval()` turns it into text such as `6h`. */
  every: number;
  /** The shortest and longest interval that may be chosen, in milliseconds. */
  minEvery: number;
  maxEvery: number;
  /** False while paused. */
  enabled: boolean;
  lastRunAt?: string;
  /** The error from the last run, when it failed. */
  lastError?: string;
  /** When it next runs while a chat has the canvas open; absent while paused or before its first run. */
  nextRunAt?: string;
  /** Who may control it; absent when only code may. */
  controls?: JobControls;
  /** True for a job added from a job with input, which may be removed. */
  added: boolean;
}

/** A job declared by the canvas, for UIs that add jobs from a job with input. */
export interface JobDefinitionInfo {
  name: string;
  description?: string;
  every: number;
  minEvery: number;
  maxEvery: number;
  controls?: JobControls;
  /** True when it takes input: users add jobs from it instead of it running on its own. */
  hasInput: boolean;
  maxJobs: number;
}

/** Built-in actions added for jobs with `controls`. */
export const JOB_ACTIONS = {
  list: 'list_jobs',
  update: 'update_job',
  run: 'run_job',
  add: 'add_job',
  remove: 'remove_job',
} as const;
export type JobAction = (typeof JOB_ACTIONS)[keyof typeof JOB_ACTIONS];
