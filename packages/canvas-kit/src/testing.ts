import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionInput, ActionResult, ActionsOf, AgentMessage, AnyCanvas, JobName, JobStatusOf, StateOf } from './define.ts';
import type { JobAction } from './jobs.ts';
import { CanvasHost, type JobOutcome, type OpenResult, type RunJobOptions } from './server/host.ts';
import type { ReleaseInfo } from './server/release.ts';
import type { StateStoreOptions } from './server/storage.ts';

/** Actions a test can call: the canvas's own, `get_state`, and the built-in job actions. */
export type HarnessAction<C extends AnyCanvas> = Extract<keyof ActionsOf<C>, string> | 'get_state' | JobAction;
export type HarnessInput<C extends AnyCanvas, K> = K extends keyof ActionsOf<C>
  ? ActionInput<C, K>
  : K extends JobAction
    ? Record<string, unknown>
    : Record<string, never>;
export type HarnessResult<C extends AnyCanvas, K> = K extends keyof ActionsOf<C> ? ActionResult<C, K> : K extends JobAction ? unknown : StateOf<C>;

export interface TestCanvas<C extends AnyCanvas> {
  readonly host: CanvasHost;
  /** Temporary folder used instead of `<copilot-home>/extension-data`. */
  readonly dataRoot: string;
  /** Messages actions sent with `ctx.sendToAgent()`, oldest first. */
  readonly sentToAgent: AgentMessage[];
  open(instanceId: string, input?: unknown): Promise<OpenResult>;
  invoke<K extends HarnessAction<C>>(
    instanceId: string,
    action: K,
    input?: HarnessInput<C, K>,
    source?: 'agent' | 'ui',
  ): Promise<HarnessResult<C, K>>;
  state(instanceId: string): StateOf<C> | undefined;
  /** The instance's jobs, as `useJobs()` shows them. */
  jobs(instanceId: string): JobStatusOf<C>[] | undefined;
  /**
   * Run a job now (even if not due or paused, unless `force: false`) for an instance
   * or a saved key: a job's name, or the ID of a job added from a job with input.
   */
  runJob(id: JobName<C> | (string & {}), options?: RunJobOptions): Promise<JobOutcome>;
  /** Run every due job once, as the host's timer does. */
  tickJobs(): Promise<void>;
  /** Close the host and delete the temporary data folder. */
  close(): Promise<void>;
}

export interface TestCanvasOptions {
  uiDir?: string;
  dataRoot?: string;
  release?: ReleaseInfo;
  /** Replace the default recorder, for example to simulate a failed send. */
  sendToAgent?: (message: AgentMessage) => Promise<void>;
  /** The clock for `ctx.now()` and job schedules. */
  now?: () => number;
  /** Run due jobs on a timer (`auto`) or only through `runJob` and `tickJobs` (`manual`, the default). */
  jobs?: 'auto' | 'manual';
  /** Cross-process lock timings, for tests of contention. */
  store?: StateStoreOptions;
}

/**
 * Run a canvas definition with a real HTTP server and private storage in a
 * temporary folder, without the Copilot SDK.
 */
export async function createTestCanvas<C extends AnyCanvas>(canvas: C, options: TestCanvasOptions = {}): Promise<TestCanvas<C>> {
  const ownsData = !options.dataRoot;
  const dataRoot = options.dataRoot ?? (await mkdtemp(join(tmpdir(), 'canvas-kit-test-')));
  const sentToAgent: AgentMessage[] = [];
  const host = new CanvasHost(canvas, {
    uiDir: options.uiDir,
    dataRoot,
    release: options.release,
    sendToAgent:
      options.sendToAgent ??
      (async message => {
        sentToAgent.push(message);
      }),
    now: options.now,
    jobs: options.jobs ?? 'manual',
    store: options.store,
  });
  return {
    host,
    dataRoot,
    sentToAgent,
    open: (instanceId, input) => host.open({ instanceId, input }),
    invoke: (instanceId, action, input, source = 'agent') =>
      host.invoke({ instanceId, actionName: action, input, source }) as never,
    state: instanceId => host.snapshot(instanceId)?.state as StateOf<C> | undefined,
    jobs: instanceId => host.snapshot(instanceId)?.jobs as JobStatusOf<C>[] | undefined,
    runJob: (id, runOptions) => host.runJob(id, runOptions),
    tickJobs: () => host.tickJobs(),
    close: async () => {
      await host.close();
      if (ownsData) await rm(dataRoot, { recursive: true, force: true });
    },
  };
}
