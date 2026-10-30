import { z } from 'zod';
import { CanvasKitError } from './errors.ts';
import { INTERVAL_PATTERN, JOB_ACTIONS, intervalMs, type Interval, type JobAction, type JobControls, type JobStatus } from './jobs.ts';

export { formatInterval, intervalMs } from './jobs.ts';
export type { Interval, JobAction, JobControls, JobDefinitionInfo, JobStatus } from './jobs.ts';

export type LogLevel = 'info' | 'warning' | 'error';
export type ActionSource = 'agent' | 'ui';
/** Who may call an action: the agent, the canvas UI, or both (the default). */
export type ActionExposure = 'both' | 'agent' | 'ui';
export type JsonSchema = Record<string, unknown>;

/** A message for the agent in the current session. */
export interface AgentMessage {
  /** The full prompt the agent receives. */
  prompt: string;
  /** Short text shown in the chat instead of the full prompt. */
  displayPrompt?: string;
  /** `enqueue` (default) waits for the agent's current turn; `immediate` steers it. */
  mode?: 'enqueue' | 'immediate';
}

export interface ActionContext<S> {
  readonly canvasId: string;
  readonly instanceId: string;
  readonly source: ActionSource;
  /** The latest state, including changes made earlier in this action. */
  readonly state: S;
  /** Private folder for this canvas's extra files, shared by every session on the machine. */
  readonly dataDir: string;
  /** Validate and apply a new state, then push it to every open view. */
  setState(next: S | ((current: S) => S)): S;
  /** Send a message to the agent. Fails with `agent_unavailable` when there is no session. */
  sendToAgent(message: AgentMessage): Promise<void>;
  log(message: string, level?: LogLevel): void;
  /** The current time in milliseconds. Tests can fix it with the host's `now` option. */
  now(): number;
}

/** What a scheduled job gets: the document it runs for, like an action, without an instance. */
export interface JobContext<S> {
  readonly canvasId: string;
  /** The job's name. */
  readonly job: string;
  /** This job's ID: its name, or the generated ID of a job added from a job with input. */
  readonly id: string;
  /** The document's persist key, or undefined for a canvas without `persist`. */
  readonly key: string | undefined;
  /**
   * True under `canvas-kit run`, which runs the job with no chat or agent:
   * `sendToAgent` fails with `agent_unavailable`, so skip agent work.
   */
  readonly headless: boolean;
  /** When this job last ran for this document, in ISO format, or undefined before its first run. */
  readonly lastRunAt: string | undefined;
  readonly state: S;
  readonly dataDir: string;
  setState(next: S | ((current: S) => S)): S;
  sendToAgent(message: AgentMessage): Promise<void>;
  log(message: string, level?: LogLevel): void;
  now(): number;
}

export interface JobSpec<S, I extends z.ZodType | undefined = undefined> {
  /**
   * How often to run, at least 1 second apart. For a canvas with `persist`, each
   * document's last run is saved with it, so a job runs once per interval no matter
   * how many chats have the document open, and runs at once when it is overdue.
   * For a job with `input`, this is the default interval of the jobs added from it.
   */
  every: Interval;
  /** What the job does. The agent reads it, and UIs may show it. */
  description?: string;
  /**
   * Let the canvas UI (`useJobs()`), the agent (the `list_jobs`, `update_job`,
   * `run_job`, `add_job`, and `remove_job` actions), or both pause, resume, retime,
   * and run this job. Omit to leave it to code.
   */
  controls?: JobControls;
  /** The shortest interval that may be chosen. Defaults to `every`. */
  minEvery?: Interval;
  /** The longest interval that may be chosen. Defaults to 30 days, or `every` when longer. */
  maxEvery?: Interval;
  /**
   * Zod schema for the input of jobs added from this one. With `input`, the job does
   * not run on its own: the UI or the agent adds jobs from it, each with its own
   * input, interval, and run history. Needs `controls`.
   */
  input?: I;
  /** For a job with `input`, how many jobs may be added from it per document. Defaults to 20. */
  maxJobs?: number;
  run(ctx: JobContext<S>, input: I extends z.ZodType ? z.output<I> : undefined): void | Promise<void>;
}

// oxlint-disable-next-line typescript/no-explicit-any -- job inputs vary per job.
export type JobMap<S> = Record<string, JobSpec<S, any>>;

export interface JobHelpers<S> {
  /** Declare a scheduled job with typed state and input. */
  job<I extends z.ZodType | undefined = undefined>(spec: JobSpec<S, I>): NoInfer<JobSpec<S, I>>;
}

const emptyInput = z.object({}).strict();
export type EmptyInput = typeof emptyInput;

export interface ActionSpec<S, I extends z.ZodType = EmptyInput, R = unknown, E extends ActionExposure = 'both'> {
  description: string;
  /** Zod schema for the input. Omit for actions without input. */
  input?: I;
  expose?: E;
  run(ctx: ActionContext<S>, input: z.output<I>): R | Promise<R>;
}

// oxlint-disable-next-line typescript/no-explicit-any -- action inputs and results vary per action.
export type ActionMap<S> = Record<string, ActionSpec<S, any, any, ActionExposure>>;

export interface ActionHelpers<S> {
  /** Declare an action with typed input and state. */
  action<I extends z.ZodType = EmptyInput, R = unknown, E extends ActionExposure = 'both'>(
    spec: ActionSpec<S, I, R, E>,
  ): NoInfer<ActionSpec<S, I, R, E>>;
}

export interface OpenContext<I> {
  readonly instanceId: string;
  readonly input: I;
}

export interface ReopenContext<S, I> extends OpenContext<I> {
  readonly state: S;
}

export interface PersistOptions<I> {
  /**
   * Stable domain identity for the saved state, such as a file path or record ID.
   * Every instance that returns the same key shares one document, in this chat and
   * in other chats: changes apply one at a time under a lock, each change starts
   * from the latest saved state, and open pages update live. Reopening an instance
   * with input that maps to a different key switches it to that document.
   */
  key(ctx: OpenContext<I>): string;
  /** Increment when the saved state shape changes incompatibly. */
  version?: number;
}

export interface CanvasSpec<
  SS extends z.ZodType,
  IS extends z.ZodType,
  A extends ActionMap<z.output<SS>>,
  J extends JobMap<z.output<SS>> = Record<never, never>,
> {
  /** Stable kebab-case canvas ID. Qualify generic names, for example `octo-release-board`. */
  id: string;
  /** Short display name, also used as the panel title. */
  title: string;
  /** Single-sentence description shown to the agent. */
  description: string;
  /** Zod schema for the instance state shared with the UI. */
  state: SS;
  /** Zod schema for the `open_canvas` input. Omit when the canvas takes no input. */
  input?: IS;
  /** Create the initial state for a new instance. */
  init(ctx: OpenContext<z.output<IS>>): z.input<SS> | Promise<z.input<SS>>;
  /** Update the state when an existing instance is opened again. Return nothing to keep it. */
  reopen?(ctx: ReopenContext<z.output<SS>, z.output<IS>>): z.input<SS> | void | Promise<z.input<SS> | void>;
  /** Optional status text returned to the host when the canvas opens. */
  status?(state: z.output<SS>): string | undefined;
  /** Save state privately under `<copilot-home>/extension-data/<id>/`. */
  persist?: PersistOptions<z.output<IS>>;
  /** Show the plugin version and publish time in a page footer. Defaults to true. */
  versionFooter?: boolean;
  /** Extra Content-Security-Policy sources for this canvas's pages. Other canvases keep the defaults. */
  csp?: CanvasCsp;
  actions?(helpers: ActionHelpers<z.output<SS>>): A;
  /**
   * Scheduled jobs. They run for each open document while a chat has the canvas
   * open, and `canvas-kit run <job>` runs them for saved documents with no chat open.
   */
  jobs?(helpers: JobHelpers<z.output<SS>>): J;
}

export interface CanvasCsp {
  /**
   * Sources added to `connect-src` after `'self'`, for example `ws://127.0.0.1:*`
   * to open WebSockets to local services. Each entry must be a
   * `scheme://host[:port]` source with an `http`, `https`, `ws`, or `wss` scheme.
   */
  connectSrc?: readonly string[];
}

export interface CompiledAction {
  readonly name: string;
  readonly description: string;
  readonly expose: ActionExposure;
  readonly input: z.ZodType;
  readonly inputJsonSchema: JsonSchema;
  /** Set on the built-in job actions, which the host runs itself. */
  readonly jobAction?: JobAction;
  run(ctx: ActionContext<unknown>, input: unknown): unknown;
}

export interface CompiledJob {
  readonly name: string;
  readonly description: string | undefined;
  readonly everyMs: number;
  readonly minEveryMs: number;
  readonly maxEveryMs: number;
  readonly controls: JobControls | undefined;
  /** Input schema of a job that other jobs are added from. */
  readonly input: z.ZodType | undefined;
  readonly maxJobs: number;
  run(ctx: JobContext<unknown>, input: unknown): void | Promise<void>;
}

export interface CanvasDefinition<
  SS extends z.ZodType = z.ZodType,
  IS extends z.ZodType = z.ZodType,
  // oxlint-disable-next-line typescript/no-explicit-any -- see ActionMap.
  A extends ActionMap<any> = ActionMap<any>,
  // oxlint-disable-next-line typescript/no-explicit-any -- see ActionMap.
  J extends JobMap<any> = JobMap<any>,
> {
  readonly kind: 'canvas-kit/canvas';
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly state: SS;
  readonly input: IS | undefined;
  readonly inputJsonSchema: JsonSchema | undefined;
  readonly versionFooter: boolean;
  readonly csp: { readonly connectSrc: readonly string[] };
  readonly actions: ReadonlyMap<string, CompiledAction>;
  readonly jobs: ReadonlyMap<string, CompiledJob>;
  readonly persist: { key(ctx: OpenContext<unknown>): string; version: number } | undefined;
  init(ctx: OpenContext<unknown>): unknown;
  reopen(ctx: ReopenContext<unknown, unknown>): unknown;
  status(state: unknown): string | undefined;
  /** Type-only marker for the declared actions. */
  readonly __actions?: A;
  /** Type-only marker for the declared jobs. */
  readonly __jobs?: J;
}

// oxlint-disable-next-line typescript/no-explicit-any -- accepts any canvas definition.
export type AnyCanvas = CanvasDefinition<any, any, any, any>;
export type StateOf<C extends AnyCanvas> = C extends CanvasDefinition<infer SS> ? z.output<SS> : never;
export type ActionsOf<C extends AnyCanvas> = C extends CanvasDefinition<z.ZodType, z.ZodType, infer A> ? A : never;
// oxlint-disable-next-line typescript/no-explicit-any -- matches any canvas.
export type JobsOf<C extends AnyCanvas> = C extends CanvasDefinition<any, any, any, infer J> ? J : never;
/** Names of a canvas's scheduled jobs. */
export type JobName<C extends AnyCanvas> = Extract<keyof JobsOf<C>, string>;
// oxlint-disable-next-line typescript/no-explicit-any -- matches a job for any state type.
type InputOfJob<T> = T extends JobSpec<any, infer I> ? I : never;
/** Names of jobs with `input`, which users add jobs from. */
export type JobWithInputName<C extends AnyCanvas> = {
  [K in JobName<C>]: InputOfJob<JobsOf<C>[K]> extends z.ZodType ? K : never;
}[JobName<C>];
/** The input of jobs added from job `K`. */
export type JobInput<C extends AnyCanvas, K extends JobName<C>> =
  InputOfJob<JobsOf<C>[K]> extends infer I extends z.ZodType ? z.input<I> : undefined;
/** A job's status, typed by the canvas's jobs. */
export type JobStatusOf<C extends AnyCanvas> = { [K in JobName<C>]: JobStatus<K, JobInput<C, K>> }[JobName<C>];
// oxlint-disable-next-line typescript/no-explicit-any -- matches an action for any state type.
type AnyAction<I extends z.ZodType = any, R = any, E extends ActionExposure = any> = ActionSpec<any, I, R, E>;
type ExposedTo<A, Who extends ActionExposure> = {
  [K in keyof A]: A[K] extends AnyAction<z.ZodType, unknown, infer E> ? (E extends 'both' | Who ? K : never) : never;
}[keyof A];
/** Names of actions the canvas UI may call. */
export type UiActionName<C extends AnyCanvas> = Extract<ExposedTo<ActionsOf<C>, 'ui'>, string>;
export type ActionInput<C extends AnyCanvas, K extends keyof ActionsOf<C>> =
  ActionsOf<C>[K] extends AnyAction<infer I> ? z.input<I> : never;
export type ActionResult<C extends AnyCanvas, K extends keyof ActionsOf<C>> =
  ActionsOf<C>[K] extends AnyAction<z.ZodType, infer R> ? Awaited<R> : never;

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTION_PATTERN = /^[a-z][a-z0-9_]*$/;
// scheme://host[:port], where host may start with `*.` and port may be `*`. No paths, keywords, or bare wildcards.
const CSP_SOURCE_PATTERN = /^(?:https?|wss?):\/\/(?:\[::1\]|(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::(?:\*|[0-9]{1,5}))?$/;

function compileCsp(id: string, csp: CanvasCsp | undefined): CanvasDefinition['csp'] {
  const connectSrc = [...(csp?.connectSrc ?? [])];
  for (const source of connectSrc) {
    if (typeof source !== 'string' || !CSP_SOURCE_PATTERN.test(source)) {
      throw new Error(`Canvas ${id} has an invalid csp.connectSrc source: ${JSON.stringify(source)}. Use scheme://host[:port].`);
    }
  }
  return { connectSrc: [...new Set(connectSrc)] };
}

const DEFAULT_MAX_EVERY_MS = 30 * 86_400_000;
const DEFAULT_MAX_JOBS = 20;
const CONTROLS: readonly JobControls[] = ['both', 'ui', 'agent'];

function checkedInterval(name: string, field: string, every: Interval): number {
  const ms = intervalMs(every);
  if (!Number.isFinite(ms) || ms < 1_000) {
    throw new Error(`Job ${name} needs ${field}: at least 1 second, such as '30s', '15m', '6h', '1d', or milliseconds`);
  }
  return ms;
}

function compileJob(name: string, job: JobSpec<unknown, z.ZodType | undefined>): CompiledJob {
  if (!ACTION_PATTERN.test(name)) throw new Error(`Job names must be snake_case: ${name}`);
  if (typeof job?.run !== 'function') throw new Error(`Job ${name} needs a run() function`);
  const everyMs = checkedInterval(name, 'every', job.every);
  const minEveryMs = job.minEvery === undefined ? everyMs : checkedInterval(name, 'minEvery', job.minEvery);
  const maxEveryMs = job.maxEvery === undefined ? Math.max(everyMs, DEFAULT_MAX_EVERY_MS) : checkedInterval(name, 'maxEvery', job.maxEvery);
  if (minEveryMs > everyMs || everyMs > maxEveryMs) throw new Error(`Job ${name} needs minEvery <= every <= maxEvery`);
  if (job.controls !== undefined && !CONTROLS.includes(job.controls)) {
    throw new Error(`Job ${name} has invalid controls: use 'both', 'ui', or 'agent'`);
  }
  if (job.input !== undefined && typeof (job.input as z.ZodType).safeParseAsync !== 'function') {
    throw new Error(`Job ${name} needs a Zod schema for input`);
  }
  if (job.input !== undefined && job.controls === undefined) {
    throw new Error(`Job ${name} has input, so it needs controls: the UI or the agent adds jobs from it`);
  }
  const maxJobs = job.maxJobs ?? DEFAULT_MAX_JOBS;
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 1_000) throw new Error(`Job ${name} needs maxJobs between 1 and 1000`);
  return {
    name,
    description: job.description,
    everyMs,
    minEveryMs,
    maxEveryMs,
    controls: job.controls,
    input: job.input,
    maxJobs,
    run: job.run as CompiledJob['run'],
  };
}

/**
 * The job a job ID belongs to: a declared job's name, or `<name>-<hex>` for a job
 * added from a job with input. Throws `not_found` with the canvas's job names.
 */
export function jobForId(canvas: AnyCanvas, id: string): CompiledJob {
  const declared = canvas.jobs.get(id);
  if (declared) return declared;
  const added = /^([a-z][a-z0-9_]*)-[0-9a-f]+$/.exec(id);
  const job = added ? canvas.jobs.get(added[1]!) : undefined;
  if (job?.input) return job;
  const known = [...canvas.jobs.keys()];
  throw new CanvasKitError('not_found', `${canvas.title} has no job ${id}. Its jobs: ${known.length ? known.join(', ') : 'none'}.`);
}

/** Who may call a built-in job action: everyone any of the jobs it covers lets in. */
function exposureFor(jobs: CompiledJob[]): ActionExposure {
  const ui = jobs.some(job => job.controls === 'both' || job.controls === 'ui');
  const agent = jobs.some(job => job.controls === 'both' || job.controls === 'agent');
  return ui && agent ? 'both' : ui ? 'ui' : 'agent';
}

const intervalInput = z
  .union([z.number().int().min(1_000), z.string().regex(INTERVAL_PATTERN)])
  .describe("Interval such as '15m', '6h', or '1d', or milliseconds");
const jobId = z.string().min(1).max(100).describe('The job ID from list_jobs');

/** The built-in actions for jobs with `controls`; the host runs them. */
function jobActions(title: string, jobs: CompiledJob[]): CompiledAction[] {
  const controlled = jobs.filter(job => job.controls !== undefined);
  if (controlled.length === 0) return [];
  const builtIn = (jobAction: JobAction, description: string, input: z.ZodType, covers: CompiledJob[]): CompiledAction => ({
    name: jobAction,
    description,
    expose: exposureFor(covers),
    input,
    inputJsonSchema: toJsonSchema(input),
    jobAction,
    run: () => {
      throw new CanvasKitError('internal_error', `${jobAction} runs in the canvas host`);
    },
  });
  const actions = [
    builtIn(
      JOB_ACTIONS.list,
      `List this ${title} document's scheduled jobs: their IDs, intervals, whether they are paused, and their last and next runs.`,
      emptyInput,
      controlled,
    ),
    builtIn(
      JOB_ACTIONS.update,
      'Pause or resume a scheduled job, or change how often it runs, by its ID from list_jobs.',
      z.object({ id: jobId, enabled: z.boolean().optional(), every: intervalInput.optional() }).strict(),
      controlled,
    ),
    builtIn(JOB_ACTIONS.run, 'Run a scheduled job now, by its ID from list_jobs.', z.object({ id: jobId }).strict(), controlled),
  ];
  const withInput = controlled.filter(job => job.input !== undefined);
  if (withInput.length > 0) {
    const variants = withInput.map(job =>
      z
        .object({ job: z.literal(job.name), input: job.input!, every: intervalInput.optional(), enabled: z.boolean().optional() })
        .strict(),
    );
    const input = variants.length === 1 ? variants[0]! : z.discriminatedUnion('job', variants as [(typeof variants)[0], ...typeof variants]);
    const kinds = withInput.map(job => (job.description ? `${job.name} (${job.description})` : job.name)).join('; ');
    actions.push(
      builtIn(
        JOB_ACTIONS.add,
        `Add a scheduled job from one of: ${kinds}. It runs soon after it is added, then on its interval. Returns its ID.`,
        input,
        withInput,
      ),
      builtIn(JOB_ACTIONS.remove, 'Remove a job added with add_job, by its ID.', z.object({ id: jobId }).strict(), withInput),
    );
  }
  return actions;
}

export function toJsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  return rest;
}

export async function parseWith<T extends z.ZodType>(schema: T, value: unknown, label: string): Promise<z.output<T>> {
  const result = await schema.safeParseAsync(value);
  if (!result.success) throw new CanvasKitError('invalid_input', `${label}: ${z.prettifyError(result.error)}`);
  return result.data;
}

/**
 * Declare a canvas: its state, open input, and actions. The kit supplies the
 * HTTP server, live state sync, persistence, and Copilot SDK registration.
 */
export function defineCanvas<
  SS extends z.ZodType,
  IS extends z.ZodType = z.ZodUndefined,
  A extends ActionMap<z.output<SS>> = Record<never, never>,
  J extends JobMap<z.output<SS>> = Record<never, never>,
>(spec: CanvasSpec<SS, IS, A, J>): CanvasDefinition<SS, IS, A, J> {
  if (!ID_PATTERN.test(spec.id)) throw new Error(`Canvas id must be kebab-case: ${spec.id}`);
  if (!spec.title.trim()) throw new Error(`Canvas ${spec.id} needs a title`);
  if (!spec.description.trim()) throw new Error(`Canvas ${spec.id} needs a description`);

  const declared = spec.actions?.({ action: definition => definition }) ?? ({} as A);
  const actions = new Map<string, CompiledAction>();
  for (const [name, action] of Object.entries(declared)) {
    if (!ACTION_PATTERN.test(name)) throw new Error(`Action names must be snake_case: ${name}`);
    if (typeof action?.run !== 'function') throw new Error(`Action ${name} needs a run() function`);
    const input = action.input ?? emptyInput;
    actions.set(name, {
      name,
      description: action.description,
      expose: action.expose ?? 'both',
      input,
      inputJsonSchema: toJsonSchema(input),
      run: action.run as CompiledAction['run'],
    });
  }
  if (!actions.has('get_state')) {
    actions.set('get_state', {
      name: 'get_state',
      description: `Read the current state of this ${spec.title} instance, including changes made in its UI.`,
      expose: 'agent',
      input: emptyInput,
      inputJsonSchema: toJsonSchema(emptyInput),
      run: ctx => ctx.state,
    });
  }

  const declaredJobs: JobMap<z.output<SS>> = spec.jobs?.({ job: definition => definition as never }) ?? {};
  const jobs = new Map<string, CompiledJob>();
  for (const [name, job] of Object.entries(declaredJobs)) jobs.set(name, compileJob(name, job as JobSpec<unknown, z.ZodType | undefined>));
  for (const action of jobActions(spec.title, [...jobs.values()])) {
    if (actions.has(action.name)) throw new Error(`Action ${action.name} is reserved for job controls; rename it`);
    actions.set(action.name, action);
  }

  return {
    kind: 'canvas-kit/canvas',
    id: spec.id,
    title: spec.title,
    description: spec.description,
    state: spec.state,
    input: spec.input,
    inputJsonSchema: spec.input ? toJsonSchema(spec.input) : undefined,
    versionFooter: spec.versionFooter ?? true,
    csp: compileCsp(spec.id, spec.csp),
    actions,
    jobs,
    persist: spec.persist
      ? { key: spec.persist.key as (ctx: OpenContext<unknown>) => string, version: spec.persist.version ?? 1 }
      : undefined,
    init: spec.init as (ctx: OpenContext<unknown>) => unknown,
    reopen: ctx => spec.reopen?.(ctx as ReopenContext<z.output<SS>, z.output<IS>>),
    status: state => spec.status?.(state as z.output<SS>),
  };
}
