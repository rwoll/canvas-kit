import type { AnyCanvas, ActionInput, ActionResult, JobInput, JobStatusOf, JobWithInputName, StateOf, UiActionName } from './define.ts';
import { JOB_ACTIONS, type Interval, type JobDefinitionInfo, type JobStatus } from './jobs.ts';
import type { ReleaseInfo } from './server/release.ts';

export { formatInterval, intervalMs } from './jobs.ts';
export type { Interval, JobControls, JobDefinitionInfo, JobStatus } from './jobs.ts';
export type { ReleaseInfo } from './server/release.ts';

export type ConnectionStatus = 'connecting' | 'live' | 'offline';

export interface CanvasSnapshot<S> {
  readonly state: S;
  /** The document's jobs, live; empty for a canvas without jobs. */
  readonly jobs: readonly JobStatus[];
  readonly revision: number;
  readonly status: ConnectionStatus;
  readonly error: string | undefined;
}

interface Bootstrap {
  base: string;
  token: string;
  revision: number;
  state: unknown;
  jobs?: JobStatus[];
  jobDefinitions?: JobDefinitionInfo[];
  release?: ReleaseInfo;
}

/** Options for a job added from a job with input. */
export interface AddJobOptions {
  /** Defaults to the job's `every`. */
  every?: Interval;
  /** Add it paused. */
  enabled?: boolean;
}

/** An action call rejected by the canvas server. */
export class CanvasActionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CanvasActionError';
    this.code = code;
  }
}

/** Actions without required input may be called without an input argument. */
export type InputArgs<C extends AnyCanvas, K extends UiActionName<C>> =
  Record<string, never> extends ActionInput<C, K> ? [input?: ActionInput<C, K>] : [input: ActionInput<C, K>];

export type RunAction<C extends AnyCanvas> = <K extends UiActionName<C>>(
  name: K,
  ...args: InputArgs<C, K>
) => Promise<ActionResult<C, K>>;

function readBootstrap(): Bootstrap {
  const element = document.getElementById('canvas-kit-bootstrap');
  if (!element?.textContent) throw new Error('Canvas bootstrap data is missing; open this page through the canvas server.');
  return JSON.parse(element.textContent) as Bootstrap;
}

const delay = (ms: number) => new Promise(done => setTimeout(done, ms));

/**
 * Browser connection to the canvas server: live state over server-sent events
 * and action calls over same-origin POST requests.
 */
export class CanvasClient<C extends AnyCanvas = AnyCanvas> {
  readonly #bootstrap: Bootstrap;
  readonly #fetch: typeof fetch;
  readonly #listeners = new Set<() => void>();
  readonly #abort = new AbortController();
  #snapshot: CanvasSnapshot<StateOf<C>>;
  #started = false;

  constructor(bootstrap: Bootstrap = readBootstrap(), options: { fetch?: typeof fetch } = {}) {
    this.#bootstrap = bootstrap;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#snapshot = {
      state: bootstrap.state as StateOf<C>,
      jobs: bootstrap.jobs ?? [],
      revision: bootstrap.revision,
      status: 'connecting',
      error: undefined,
    };
  }

  getSnapshot = (): CanvasSnapshot<StateOf<C>> => this.#snapshot;

  /** The running build, for canvases that render their own version footer. */
  get release(): ReleaseInfo | undefined {
    return this.#bootstrap.release;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (!this.#started) {
      this.#started = true;
      void this.#connect();
    }
    return () => this.#listeners.delete(listener);
  };

  /** Stop live updates. */
  close() {
    this.#abort.abort();
  }

  /** The jobs the canvas declares, including those users add jobs from. */
  get jobDefinitions(): readonly JobDefinitionInfo[] {
    return this.#bootstrap.jobDefinitions ?? [];
  }

  run: RunAction<C> = (name, ...args) => this.#post(name, args[0] ?? {}) as never;

  /** Pause or resume a job, or change its interval, for a job whose `controls` include the UI. */
  updateJob = (id: string, patch: { enabled?: boolean; every?: Interval }): Promise<JobStatusOf<C>> =>
    this.#post(JOB_ACTIONS.update, { id, ...patch }) as Promise<JobStatusOf<C>>;

  /** Run a job now, even if it is paused. Fails with `job_failed` when the job throws. */
  runJob = (id: string): Promise<JobStatusOf<C>> => this.#post(JOB_ACTIONS.run, { id }) as Promise<JobStatusOf<C>>;

  /** Add a job from a job with input. It runs soon, then on its interval. */
  addJob = <K extends JobWithInputName<C>>(job: K, input: JobInput<C, K>, options: AddJobOptions = {}): Promise<JobStatusOf<C>> =>
    this.#post(JOB_ACTIONS.add, { job, input, ...options }) as Promise<JobStatusOf<C>>;

  /** Remove a job added from a job with input. */
  removeJob = async (id: string): Promise<void> => {
    await this.#post(JOB_ACTIONS.remove, { id });
  };

  async #post(name: string, input: unknown): Promise<unknown> {
    const response = await this.#fetch(`${this.#bootstrap.base}__canvas/actions/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': this.#bootstrap.token },
      body: JSON.stringify(input),
    });
    const body = (await response.json().catch(() => undefined)) as
      | { ok: true; result: unknown }
      | { ok: false; code: string; message: string }
      | undefined;
    if (!response.ok || !body?.ok) {
      const failure = body && !body.ok ? body : undefined;
      throw new CanvasActionError(failure?.code ?? 'request_failed', failure?.message ?? `Request failed with ${response.status}`);
    }
    return body.result;
  }

  #update(patch: Partial<CanvasSnapshot<StateOf<C>>>) {
    this.#snapshot = { ...this.#snapshot, ...patch };
    // Lets tests and tools wait for a live page: html[data-canvas-status="live"].
    if (typeof document !== 'undefined') document.documentElement.dataset.canvasStatus = this.#snapshot.status;
    for (const listener of this.#listeners) listener();
  }

  async #connect() {
    const signal = this.#abort.signal;
    for (let attempt = 0; !signal.aborted; attempt += 1) {
      try {
        const response = await this.#fetch(`${this.#bootstrap.base}__canvas/events`, {
          headers: { Accept: 'text/event-stream', 'X-Canvas-Token': this.#bootstrap.token },
          cache: 'no-store',
          signal,
        });
        if (response.status === 404 || response.status === 403) {
          this.#update({ status: 'offline', error: 'This canvas was closed. Ask the agent to reopen it.' });
          return;
        }
        if (!response.ok || !response.body) throw new Error(`Live updates failed with ${response.status}`);
        attempt = 0;
        await this.#read(response.body);
        throw new Error('Live updates disconnected');
      } catch (error) {
        if (signal.aborted) return;
        this.#update({ status: 'offline', error: error instanceof Error ? error.message : String(error) });
      }
      await delay(Math.min(10_000, 500 * 2 ** attempt));
      if (signal.aborted) return;
      this.#update({ status: 'connecting' });
    }
  }

  async #read(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = event
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        const snapshot = JSON.parse(data) as { revision: number; state: StateOf<C>; jobs?: JobStatus[] };
        this.#update({ state: snapshot.state, jobs: snapshot.jobs ?? [], revision: snapshot.revision, status: 'live', error: undefined });
      }
    }
  }
}

let shared: CanvasClient | undefined;

/** The page's shared connection, created from the bootstrap data the server embeds. */
export function getCanvasClient<C extends AnyCanvas>(): CanvasClient<C> {
  shared ??= new CanvasClient();
  return shared as unknown as CanvasClient<C>;
}
