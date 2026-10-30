import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, extname, join, resolve, sep } from 'node:path';
import {
  jobForId,
  parseWith,
  type ActionContext,
  type ActionSource,
  type AgentMessage,
  type AnyCanvas,
  type CompiledJob,
  type JobContext,
  type LogLevel,
} from '../define.ts';
import { CanvasKitError, errorMessage } from '../errors.ts';
import { JOB_ACTIONS, formatInterval, intervalMs, type Interval, type JobAction, type JobDefinitionInfo, type JobStatus } from '../jobs.ts';
import { escapeHtml, injectReleaseFooter, insertBefore, type ReleaseInfo } from './release.ts';
import { StateStore, canvasDataDir, type JobRecord, type StateStoreOptions } from './storage.ts';

export interface CanvasHostOptions {
  /** Folder with the built UI (`index.html` and assets). Omit to serve a bare page, as in tests. */
  uiDir?: string;
  /** Parent of the per-canvas data folders. Defaults to `<copilot-home>/extension-data`. */
  dataRoot?: string;
  /** Build shown in the page footer and sent to the UI. */
  release?: ReleaseInfo;
  /** Delivers `ctx.sendToAgent()` messages. Without it, sending fails with `agent_unavailable`. */
  sendToAgent?: (message: AgentMessage) => Promise<void>;
  log?: (message: string, level: LogLevel) => void;
  /** The clock for `ctx.now()` and job schedules. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * `auto` (default) runs due jobs on a timer while documents are open; `manual`
   * runs them only through `runJob()` and `tickJobs()`, as tests do.
   */
  jobs?: 'auto' | 'manual';
  /** Watch saved documents so changes from other chats reach open pages. Defaults to true. */
  watch?: boolean;
  /**
   * How often to check open documents for changes that file watching missed, in
   * milliseconds. Defaults to 2000.
   */
  watchPollMs?: number;
  /** Cross-process lock timings for saved documents. */
  store?: StateStoreOptions;
}

/** What running a job did for one document. */
export interface JobOutcome {
  /** The job's ID: its name, or the ID of a job added from a job with input. */
  id: string;
  job: string;
  key: string | undefined;
  /** False when the job was not due yet, or paused. */
  ran: boolean;
  /** True when it did not run because it is paused. */
  paused?: boolean;
  /** The error message when the job failed. Its state changes were rolled back. */
  error?: string;
}

export interface RunJobOptions {
  /** Run it for this open instance's document. */
  instanceId?: string;
  /** Run it for the saved document with this persist key, open or not. */
  key?: string;
  /** Run even if it is not due. Defaults to true. */
  force?: boolean;
  /** Mark the run as headless (`ctx.headless`), as `canvas-kit run` does. */
  headless?: boolean;
}

export interface OpenRequest {
  instanceId: string;
  input?: unknown;
}

export interface OpenResult {
  url: string;
  title: string;
  status?: string;
}

export interface InvokeRequest {
  instanceId: string;
  actionName: string;
  input?: unknown;
  source: ActionSource;
}

export interface StateSnapshot {
  revision: number;
  state: unknown;
  /** The document's jobs, for a canvas with jobs. */
  jobs?: JobStatus[];
}

/** Data the server embeds in the page for the client library. */
export interface CanvasBootstrap extends StateSnapshot {
  base: string;
  token: string;
  release?: ReleaseInfo;
  /** The jobs the canvas declares, for a canvas with jobs. */
  jobDefinitions?: JobDefinitionInfo[];
}

/** One job of one document: a declared job, or one added from a job with input. */
interface JobEntry {
  readonly id: string;
  readonly job: CompiledJob;
  readonly record: JobRecord | undefined;
}

const allows = (controls: CompiledJob['controls'], source: ActionSource) => controls === 'both' || controls === source;

interface Stream {
  send(snapshot: StateSnapshot): void;
  end(): void;
}

/** One document's live state, shared by every instance whose persist key matches. */
interface Slot {
  readonly lock: string;
  readonly persistKey: string | undefined;
  /** File name of the saved document, for matching file change events. */
  readonly file: string | undefined;
  state: unknown;
  /** Revision of the state shown to pages; increases on every change. */
  revision: number;
  /** Revision of the saved document this state matches; see StoredDocument. */
  fileRevision: number;
  jobs: Record<string, JobRecord>;
  readonly instances: Set<Instance>;
}

interface Instance {
  readonly key: string;
  readonly token: string;
  readonly instanceId: string;
  slot: Slot;
  readonly streams: Set<Stream>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const INSTANCE_PATH = /^\/c\/([0-9a-f]{32})(\/.*)?$/;
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};
/** The page's Content-Security-Policy: strict defaults plus the canvas's own `csp` sources. */
export function contentSecurityPolicy(csp: AnyCanvas['csp']): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    ["connect-src 'self'", ...csp.connectSrc].join(' '),
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export function renderBootstrap(bootstrap: CanvasBootstrap): string {
  const json = JSON.stringify(bootstrap)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<script type="application/json" id="canvas-kit-bootstrap">${json}</script>`;
}

export function injectBootstrap(html: string, bootstrap: CanvasBootstrap): string {
  return insertBefore(html, /<\/head>/, renderBootstrap(bootstrap), 'start');
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const type = request.headers['content-type']?.split(';')[0]?.trim();
  if (type !== 'application/json') throw new CanvasKitError('invalid_input', 'Send JSON with Content-Type: application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new CanvasKitError('payload_too_large', 'Request body is too large');
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new CanvasKitError('invalid_input', 'Request body is not valid JSON');
  }
}

function tokenMatches(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Runs one canvas definition: instance lifecycle, serialized actions, state
 * persistence, and the loopback HTTP server that serves the UI and live state.
 *
 * Locks: `i:<instanceId>` serializes open, close, and actions for one instance;
 * the slot lock serializes state changes for one document. Instance locks are
 * always taken before slot locks.
 */
export class CanvasHost {
  readonly canvas: AnyCanvas;
  readonly #options: CanvasHostOptions;
  readonly #instances = new Map<string, Instance>();
  readonly #byKey = new Map<string, Instance>();
  readonly #slots = new Map<string, Slot>();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #store: StateStore | undefined;
  readonly #dataDir: string;
  readonly #csp: string;
  #server: Promise<{ server: Server; origin: string }> | undefined;
  #indexHtml: Promise<string> | undefined;
  #pendingOpens = 0;
  #watcher: FSWatcher | undefined;
  #poll: ReturnType<typeof setInterval> | undefined;
  readonly #mtimes = new Map<string, number>();
  readonly #reloads = new Map<string, ReturnType<typeof setTimeout>>();
  #jobTimer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;
  readonly #now: () => number;

  constructor(canvas: AnyCanvas, options: CanvasHostOptions = {}) {
    if (canvas?.kind !== 'canvas-kit/canvas') throw new Error('Expected a canvas created with defineCanvas()');
    this.canvas = canvas;
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#dataDir = canvasDataDir(canvas.id, options.dataRoot);
    this.#csp = contentSecurityPolicy(canvas.csp);
    this.#store = canvas.persist ? new StateStore(this.#dataDir, canvas.state, canvas.persist.version, options.store) : undefined;
  }

  log(message: string, level: LogLevel = 'info') {
    this.#options.log?.(message, level);
  }

  /** Open or reopen an instance and return the URL of its page. */
  async open(request: OpenRequest): Promise<OpenResult> {
    const instanceId = this.#checkInstanceId(request.instanceId);
    this.#pendingOpens += 1;
    try {
      return await this.#withLock(`i:${instanceId}`, async () => {
        const instance = await this.#openInstance(instanceId, request.input);
        const { origin } = await this.#ensureServer();
        return {
          url: `${origin}/c/${instance.key}/`,
          title: this.canvas.title,
          ...this.#status(instance),
        };
      });
    } finally {
      this.#pendingOpens -= 1;
    }
  }

  /** Open an instance without starting the HTTP server, as the Vite dev server does. */
  openLocal(request: OpenRequest): Promise<CanvasBootstrap> {
    const instanceId = this.#checkInstanceId(request.instanceId);
    return this.#withLock(`i:${instanceId}`, async () => this.#bootstrap(await this.#openInstance(instanceId, request.input), '/'));
  }

  /** Page bootstrap data for an open instance, without reopening it. */
  bootstrapFor(instanceId: string, base: string): CanvasBootstrap | undefined {
    const instance = this.#instances.get(instanceId);
    return instance && this.#bootstrap(instance, base);
  }

  invoke(request: InvokeRequest): Promise<unknown> {
    const instanceId = this.#checkInstanceId(request.instanceId);
    return this.#withLock(`i:${instanceId}`, async () => {
      const instance = this.#instances.get(instanceId);
      if (!instance) throw new CanvasKitError('not_open', `Open the ${this.canvas.title} canvas before using its actions`);
      return this.#withLock(instance.slot.lock, () => this.#runAction(instance, request));
    });
  }

  snapshot(instanceId: string): StateSnapshot | undefined {
    const slot = this.#instances.get(instanceId)?.slot;
    return slot && this.#snapshotOf(slot);
  }

  /** Close an instance. The HTTP server stops once no instances remain. */
  async closeInstance(instanceId: string): Promise<void> {
    await this.#withLock(`i:${instanceId}`, async () => {
      const instance = this.#instances.get(instanceId);
      if (!instance) return;
      this.#instances.delete(instanceId);
      this.#byKey.delete(instance.key);
      for (const stream of instance.streams) stream.end();
      await this.#detach(instance);
    });
    if (this.#instances.size === 0 && this.#pendingOpens === 0) await this.#stopServer();
  }

  /** Close every instance, stop jobs and file watching, and stop the HTTP server. */
  async close(): Promise<void> {
    clearInterval(this.#jobTimer);
    this.#jobTimer = undefined;
    await Promise.all([...this.#instances.keys()].map(id => this.closeInstance(id)));
    this.#unwatch();
    await this.#stopServer();
  }

  /**
   * Run every due job once for every open document. With `jobs: 'auto'` the host
   * calls this on a timer; failures are logged.
   */
  async tickJobs(): Promise<void> {
    if (this.#ticking || this.canvas.jobs.size === 0) return;
    this.#ticking = true;
    try {
      const slots = new Set([...this.#instances.values()].map(instance => instance.slot));
      for (const slot of slots) {
        for (const entry of this.#entries(slot.jobs)) {
          // A cheap check first; the job re-checks against the saved document under its lock.
          if (!this.#due(entry)) continue;
          try {
            await this.#withLock(slot.lock, () => this.#runJobFor(slot, entry.id, false, false));
          } catch (error) {
            this.log(`Job ${entry.id} could not run: ${errorMessage(error)}`, 'warning');
          }
        }
      }
    } finally {
      this.#ticking = false;
    }
  }

  /**
   * Run a job now for one document: an open instance's (`instanceId`), a saved
   * document's (`key`), or the only open document. `id` is a job's name, or the ID
   * of a job added from a job with input. Runs even if not due unless `force: false`.
   */
  async runJob(id: string, options: RunJobOptions = {}): Promise<JobOutcome> {
    const job = this.#jobFor(id);
    if (job.input && id === job.name) {
      throw new CanvasKitError('invalid_input', `${id} takes input, so only the jobs added from it run; pass one of their IDs`);
    }
    const slot = await this.#slotForJob(options);
    const outcome = await this.#withLock(slot.lock, () => this.#runJobFor(slot, id, options.force ?? true, options.headless ?? false));
    if (!outcome) throw new CanvasKitError('not_found', `No job ${id} in this document`);
    return outcome;
  }

  /**
   * Run one document's due jobs, as `canvas-kit run` does: every job, the jobs with
   * one name (including the jobs added from a job with input), or the job with one ID.
   * `force` runs them even if not due or paused.
   */
  async runJobs(selector: string | undefined, options: RunJobOptions = {}): Promise<JobOutcome[]> {
    if (selector !== undefined) this.#jobFor(selector);
    const slot = await this.#slotForJob(options);
    const outcomes: JobOutcome[] = [];
    const selected = this.#entries(slot.jobs).filter(entry => selector === undefined || entry.id === selector || entry.job.name === selector);
    for (const entry of selected) {
      try {
        const outcome = await this.#withLock(slot.lock, () => this.#runJobFor(slot, entry.id, options.force ?? false, options.headless ?? false));
        if (outcome) outcomes.push(outcome);
      } catch (error) {
        outcomes.push({ id: entry.id, job: entry.job.name, key: slot.persistKey, ran: false, error: errorMessage(error) });
      }
    }
    return outcomes;
  }

  /** The persist keys of every saved document, for running jobs without an open canvas. */
  async savedKeys(): Promise<string[]> {
    return this.#store ? this.#store.keys() : [];
  }

  async #stopServer() {
    const pending = this.#server;
    this.#server = undefined;
    if (!pending) return;
    const { server } = await pending.catch(() => ({ server: undefined }));
    if (!server) return;
    await new Promise<void>((done, fail) => {
      server.close(error => (error ? fail(error) : done()));
      server.closeAllConnections();
    });
  }

  /**
   * Handle `__canvas/*` API requests for one instance. `path` is relative to the
   * instance base, for example `__canvas/events`.
   */
  async handleApi(instanceId: string, path: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const instance = this.#instances.get(instanceId);
    if (!instance) throw new CanvasKitError('not_found', 'This canvas was closed; ask the agent to reopen it');
    if (!tokenMatches(request.headers['x-canvas-token'], instance.token)) {
      throw new CanvasKitError('forbidden', 'Canvas token required; reload the canvas');
    }
    if (path === '__canvas/state' && request.method === 'GET') {
      sendJson(response, 200, this.#snapshotOf(instance.slot));
      return;
    }
    if (path === '__canvas/events' && request.method === 'GET') {
      this.#stream(instance, request, response);
      return;
    }
    const action = /^__canvas\/actions\/([a-z][a-z0-9_]*)$/.exec(path);
    if (action && request.method === 'POST') {
      const input = await readJsonBody(request);
      const result = await this.invoke({ instanceId, actionName: action[1]!, input, source: 'ui' });
      sendJson(response, 200, { ok: true, result: result ?? null });
      return;
    }
    throw new CanvasKitError('not_found', 'Route not found');
  }

  /**
   * Run an action as the agent would through the Copilot host. Only the Vite
   * dev server uses this, so canvas UIs can be checked without an agent.
   */
  async runDevAgentAction(instanceId: string, actionName: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const input = await readJsonBody(request);
    const result = await this.invoke({ instanceId, actionName, input, source: 'agent' });
    sendJson(response, 200, { ok: true, result: result ?? null });
  }

  /** Report a request failure as JSON without leaking unexpected error details. */
  sendError(response: ServerResponse, error: unknown) {
    const known = error instanceof CanvasKitError;
    if (!known) this.log(`Canvas request failed: ${errorMessage(error)}`, 'error');
    if (response.headersSent) {
      response.end();
      return;
    }
    sendJson(response, known ? error.status : 500, {
      ok: false,
      code: known ? error.code : 'internal_error',
      message: known ? error.message : 'The canvas request failed; see the extension log.',
    });
  }

  #checkInstanceId(instanceId: unknown): string {
    if (typeof instanceId !== 'string' || instanceId.length === 0 || instanceId.length > 256) {
      throw new CanvasKitError('invalid_input', 'instanceId must be a non-empty string');
    }
    return instanceId;
  }

  #bootstrap(instance: Instance, base: string): CanvasBootstrap {
    const { release } = this.#options;
    return {
      base,
      token: instance.token,
      ...this.#snapshotOf(instance.slot),
      ...(release && { release }),
      ...(this.canvas.jobs.size > 0 && { jobDefinitions: this.#jobDefinitions() }),
    };
  }

  #status(instance: Instance): { status?: string } {
    const status = this.canvas.status(instance.slot.state);
    return status ? { status } : {};
  }

  async #withLock<T>(name: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(name) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.catch(() => {});
    this.#locks.set(name, settled);
    try {
      return await next;
    } finally {
      if (this.#locks.get(name) === settled) this.#locks.delete(name);
    }
  }

  // ---------- saved documents shared across processes ----------

  /** Run `work` holding the document's cross-process lock, starting from the latest saved state. */
  async #transact<T>(slot: Slot, work: () => Promise<T>): Promise<T> {
    const store = this.#store;
    const key = slot.persistKey;
    if (!store || key === undefined) return work();
    return store.lock(key, async () => {
      await this.#reload(slot);
      return work();
    });
  }

  /** Load the saved document if another process saved a newer revision, and show it. */
  async #reload(slot: Slot): Promise<void> {
    if (!this.#store || slot.persistKey === undefined) return;
    const saved = await this.#store.read(slot.persistKey);
    if (!saved || saved.revision === slot.fileRevision) return;
    slot.state = saved.state;
    slot.fileRevision = saved.revision;
    slot.jobs = saved.jobs;
    slot.revision += 1;
    this.#publish(slot);
  }

  /** Save the document as the next revision. Call it inside `#transact`. */
  async #persist(slot: Slot, state: unknown = slot.state, jobs: Record<string, JobRecord> = slot.jobs): Promise<void> {
    if (!this.#store || slot.persistKey === undefined) return;
    const revision = slot.fileRevision + 1;
    await this.#store.write(slot.persistKey, { state, revision, jobs });
    slot.fileRevision = revision;
  }

  #watch() {
    if (!this.#store || this.#options.watch === false) return;
    if (!this.#watcher) {
      try {
        mkdirSync(this.#store.stateDir, { recursive: true, mode: 0o700 });
        this.#watcher = watch(this.#store.stateDir, (_event, name) => {
          if (name) this.#onFileChange(String(name));
        });
        this.#watcher.on('error', error => {
          this.log(`Stopped watching saved documents: ${errorMessage(error)}`, 'warning');
          this.#watcher?.close();
          this.#watcher = undefined;
        });
        this.#watcher.unref();
      } catch (error) {
        this.log(`Checking saved documents every few seconds instead of watching them: ${errorMessage(error)}`, 'warning');
      }
    }
    // File watching can miss changes, for example when macOS restarts a process's
    // event stream, so also check the open documents' modification times.
    if (!this.#poll) {
      this.#poll = setInterval(() => void this.#pollFiles(), this.#options.watchPollMs ?? 2_000);
      this.#poll.unref();
    }
  }

  async #pollFiles() {
    const store = this.#store;
    if (!store) return;
    for (const slot of this.#slots.values()) {
      if (!slot.file) continue;
      const mtime = await stat(join(store.stateDir, slot.file)).then(
        info => info.mtimeMs,
        () => undefined,
      );
      if (mtime === undefined || this.#mtimes.get(slot.file) === mtime) continue;
      this.#mtimes.set(slot.file, mtime);
      this.#onFileChange(slot.file);
    }
  }

  #unwatch() {
    this.#watcher?.close();
    this.#watcher = undefined;
    clearInterval(this.#poll);
    this.#poll = undefined;
    this.#mtimes.clear();
    for (const timer of this.#reloads.values()) clearTimeout(timer);
    this.#reloads.clear();
  }

  #onFileChange(name: string) {
    const slot = [...this.#slots.values()].find(candidate => candidate.file === name);
    if (!slot) return;
    clearTimeout(this.#reloads.get(name));
    const timer = setTimeout(() => {
      this.#reloads.delete(name);
      void this.#withLock(slot.lock, () => this.#reload(slot)).catch(error =>
        this.log(`Could not load changes to ${slot.persistKey}: ${errorMessage(error)}`, 'warning'),
      );
    }, 25);
    timer.unref();
    this.#reloads.set(name, timer);
  }

  // ---------- jobs ----------

  #startJobs() {
    if (this.#jobTimer || this.canvas.jobs.size === 0 || this.#options.jobs === 'manual') return;
    const shortest = Math.min(...[...this.canvas.jobs.values()].map(job => job.minEveryMs));
    this.#jobTimer = setInterval(() => void this.tickJobs(), Math.min(Math.max(shortest / 4, 1_000), 30_000));
    this.#jobTimer.unref();
  }

  /** Run due jobs soon, for example after a job is added or resumed. */
  #kickJobs() {
    if (this.canvas.jobs.size === 0 || this.#options.jobs === 'manual') return;
    this.#startJobs();
    setTimeout(() => void this.tickJobs(), 0).unref();
  }

  #jobFor(id: string): CompiledJob {
    return jobForId(this.canvas, id);
  }

  /** A document's jobs: each declared job without input, then the jobs added from jobs with input, oldest first. */
  #entries(records: Record<string, JobRecord>): JobEntry[] {
    const entries: JobEntry[] = [];
    for (const job of this.canvas.jobs.values()) if (!job.input) entries.push({ id: job.name, job, record: records[job.name] });
    const added = Object.entries(records)
      .filter(([id, record]) => record.job !== undefined && this.canvas.jobs.get(record.job)?.input !== undefined && id.startsWith(`${record.job}-`))
      .sort(([, a], [, b]) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    for (const [id, record] of added) entries.push({ id, job: this.canvas.jobs.get(record.job!)!, record });
    return entries;
  }

  #entry(slot: Slot, id: string): JobEntry | undefined {
    return this.#entries(slot.jobs).find(entry => entry.id === id);
  }

  /** The interval in use: the one a user chose, kept within the job's current limits. */
  #everyMs(entry: JobEntry): number {
    // Settings users chose apply only while the job still has controls, so a later
    // version that removes them never strands a job paused or retimed.
    const every = entry.job.controls === undefined ? entry.job.everyMs : (entry.record?.every ?? entry.job.everyMs);
    return Math.min(entry.job.maxEveryMs, Math.max(entry.job.minEveryMs, every));
  }

  #enabled(entry: JobEntry): boolean {
    return entry.job.controls === undefined || entry.record?.enabled !== false;
  }

  #due(entry: JobEntry): boolean {
    if (!this.#enabled(entry)) return false;
    const last = entry.record?.lastRunAt;
    return last === undefined || this.#now() - Date.parse(last) >= this.#everyMs(entry);
  }

  #jobStatus(entry: JobEntry): JobStatus {
    const { id, job, record } = entry;
    const every = this.#everyMs(entry);
    const enabled = this.#enabled(entry);
    const last = record?.lastRunAt;
    return {
      id,
      job: job.name,
      ...(job.description !== undefined && { description: job.description }),
      ...(job.input !== undefined && { input: record?.input }),
      every,
      minEvery: job.minEveryMs,
      maxEvery: job.maxEveryMs,
      enabled,
      ...(last !== undefined && { lastRunAt: last }),
      ...(record?.lastError !== undefined && { lastError: record.lastError }),
      ...(enabled && last !== undefined && { nextRunAt: new Date(Date.parse(last) + every).toISOString() }),
      ...(job.controls !== undefined && { controls: job.controls }),
      added: job.input !== undefined,
    };
  }

  #jobDefinitions(): JobDefinitionInfo[] {
    return [...this.canvas.jobs.values()].map(job => ({
      name: job.name,
      ...(job.description !== undefined && { description: job.description }),
      every: job.everyMs,
      minEvery: job.minEveryMs,
      maxEvery: job.maxEveryMs,
      ...(job.controls !== undefined && { controls: job.controls }),
      hasInput: job.input !== undefined,
      maxJobs: job.maxJobs,
    }));
  }

  #snapshotOf(slot: Slot): StateSnapshot {
    return {
      revision: slot.revision,
      state: slot.state,
      ...(this.canvas.jobs.size > 0 && { jobs: this.#entries(slot.jobs).map(entry => this.#jobStatus(entry)) }),
    };
  }

  /** Save new job records and show them. Call it inside `#transact`. */
  async #saveJobs(slot: Slot, jobs: Record<string, JobRecord>) {
    await this.#persist(slot, slot.state, jobs);
    slot.jobs = jobs;
    slot.revision += 1;
    this.#publish(slot);
  }

  #checkEvery(job: CompiledJob, every: Interval): number {
    const ms = intervalMs(every);
    if (!(ms >= job.minEveryMs && ms <= job.maxEveryMs)) {
      throw new CanvasKitError('invalid_input', `${job.name} runs every ${formatInterval(job.minEveryMs)} to ${formatInterval(job.maxEveryMs)}`);
    }
    return ms;
  }

  /** A job that `source` may control, or not_found, so hidden jobs look absent. */
  #controlled(slot: Slot, id: string, source: ActionSource): JobEntry {
    const entry = this.#entry(slot, id);
    if (!entry || !allows(entry.job.controls, source)) throw new CanvasKitError('not_found', `No job ${id}; list_jobs shows the IDs`);
    return entry;
  }

  /** The built-in job actions. They take the document's lock themselves; call them holding the slot lock. */
  async #jobAction(slot: Slot, action: JobAction, input: Record<string, unknown>, raw: unknown, source: ActionSource): Promise<unknown> {
    const id = input.id as string;
    switch (action) {
      case JOB_ACTIONS.list:
        return this.#transact(slot, async () =>
          this.#entries(slot.jobs)
            .filter(entry => allows(entry.job.controls, source))
            .map(entry => this.#jobStatus(entry)),
        );
      case JOB_ACTIONS.update:
        return this.#transact(slot, async () => {
          const entry = this.#controlled(slot, id, source);
          const record: JobRecord = { ...entry.record };
          if (input.enabled === true) delete record.enabled;
          if (input.enabled === false) record.enabled = false;
          if (input.every !== undefined) record.every = this.#checkEvery(entry.job, input.every as Interval);
          await this.#saveJobs(slot, { ...slot.jobs, [id]: record });
          if (input.enabled === true) this.#kickJobs();
          return this.#jobStatus({ ...entry, record });
        });
      case JOB_ACTIONS.run: {
        if (!allows(this.#jobFor(id).controls, source)) throw new CanvasKitError('not_found', `No job ${id}; list_jobs shows the IDs`);
        const outcome = await this.#runJobFor(slot, id, true, false);
        if (!outcome) throw new CanvasKitError('not_found', `No job ${id}; list_jobs shows the IDs`);
        if (outcome.error) throw new CanvasKitError('job_failed', `${id} failed: ${outcome.error}`);
        const entry = this.#entry(slot, id);
        return entry && this.#jobStatus(entry);
      }
      case JOB_ACTIONS.add: {
        const job = this.canvas.jobs.get(input.job as string);
        if (!job?.input || !allows(job.controls, source)) throw new CanvasKitError('not_found', `No job ${String(input.job)} to add jobs from`);
        return this.#transact(slot, async () => {
          if (Object.values(slot.jobs).filter(record => record.job === job.name).length >= job.maxJobs) {
            throw new CanvasKitError('limit_reached', `This document already has ${job.maxJobs} ${job.name} jobs; remove one first`);
          }
          let added: string;
          do added = `${job.name}-${randomBytes(3).toString('hex')}`;
          while (slot.jobs[added]);
          const record: JobRecord = {
            job: job.name,
            // Keep the input as given, so it validates again on every run.
            input: (raw as { input?: unknown }).input,
            createdAt: new Date(this.#now()).toISOString(),
            ...(input.every !== undefined && { every: this.#checkEvery(job, input.every as Interval) }),
            ...(input.enabled === false && { enabled: false }),
          };
          await this.#saveJobs(slot, { ...slot.jobs, [added]: record });
          this.#kickJobs();
          return this.#jobStatus({ id: added, job, record });
        });
      }
      case JOB_ACTIONS.remove:
        return this.#transact(slot, async () => {
          const entry = this.#controlled(slot, id, source);
          if (!entry.job.input) throw new CanvasKitError('invalid_input', `${id} is declared by the canvas; pause it instead`);
          const { [id]: _removed, ...rest } = slot.jobs;
          await this.#saveJobs(slot, rest);
          return { removed: id };
        });
    }
  }

  async #slotForJob(options: RunJobOptions): Promise<Slot> {
    if (options.instanceId !== undefined) {
      const instance = this.#instances.get(options.instanceId);
      if (!instance) throw new CanvasKitError('not_open', `No open instance ${options.instanceId}`);
      return instance.slot;
    }
    if (options.key !== undefined) {
      const open = this.#slots.get(options.key);
      if (open) return open;
      if (!this.#store) throw new CanvasKitError('invalid_input', `${this.canvas.title} does not save documents, so it has no key ${options.key}`);
      const saved = await this.#store.read(options.key);
      if (!saved) throw new CanvasKitError('not_found', `No saved ${this.canvas.title} document for ${options.key}`);
      return this.#newSlot(options.key, saved.state, saved.revision, saved.jobs);
    }
    const slots = new Set([...this.#instances.values()].map(instance => instance.slot));
    if (slots.size === 1) return [...slots][0]!;
    throw new CanvasKitError('invalid_input', 'Pass the instanceId or key of the document to run the job for');
  }

  #newSlot(persistKey: string | undefined, state: unknown, fileRevision = 0, jobs: Record<string, JobRecord> = {}, instanceId?: string): Slot {
    return {
      lock: persistKey === undefined ? `s:i:${instanceId}` : `s:p:${persistKey}`,
      persistKey,
      file: persistKey !== undefined && this.#store ? basename(this.#store.fileFor(persistKey)) : undefined,
      state,
      revision: 1,
      fileRevision,
      jobs,
      instances: new Set(),
    };
  }

  /**
   * Run one job for one document; call it holding the slot lock. A failed job's state
   * changes roll back, and its run is still recorded. Undefined when the document has
   * no job with this ID, for example because another chat removed it.
   */
  async #runJobFor(slot: Slot, id: string, force: boolean, headless: boolean): Promise<JobOutcome | undefined> {
    return this.#transact(slot, async () => {
      const entry = this.#entry(slot, id);
      if (!entry) return undefined;
      const { job } = entry;
      const outcome: JobOutcome = { id, job: job.name, key: slot.persistKey, ran: false };
      if (!force && !this.#due(entry)) return this.#enabled(entry) ? outcome : { ...outcome, paused: true };
      const before = slot.state;
      let changed = false;
      const ctx: JobContext<unknown> = {
        canvasId: this.canvas.id,
        job: job.name,
        id,
        key: slot.persistKey,
        headless,
        lastRunAt: entry.record?.lastRunAt,
        get state() {
          return slot.state;
        },
        dataDir: this.#dataDir,
        setState: this.#setter(slot, `Job ${id}`, () => {
          changed = true;
        }),
        sendToAgent: this.#sender(),
        log: (message, level) => this.log(message, level),
        now: () => this.#now(),
      };
      const { lastError: _previous, ...kept } = entry.record ?? {};
      const record: JobRecord = { ...kept, lastRunAt: new Date(this.#now()).toISOString() };
      try {
        const input = job.input ? await parseWith(job.input, entry.record?.input, `${id} has input that ${job.name} no longer accepts`) : undefined;
        await job.run(ctx, input);
      } catch (error) {
        record.lastError = errorMessage(error);
        outcome.error = record.lastError;
        this.log(`Job ${id} failed: ${record.lastError}`, 'warning');
        if (changed) {
          slot.state = before;
          slot.revision += 1;
          this.#publish(slot);
        }
      }
      // Record the run even when it failed, so every chat waits a full interval before retrying.
      try {
        await this.#saveJobs(slot, { ...slot.jobs, [id]: record });
      } catch (error) {
        // Nothing was saved, so undo the run here too; it is retried at the next tick.
        if (slot.state !== before) {
          slot.state = before;
          slot.revision += 1;
          this.#publish(slot);
        }
        throw error;
      }
      outcome.ran = true;
      return outcome;
    });
  }

  #setter(slot: Slot, label: string, onChange: () => void) {
    return (next: unknown) => {
      const value = typeof next === 'function' ? (next as (current: unknown) => unknown)(slot.state) : next;
      const parsed = this.canvas.state.safeParse(value);
      if (!parsed.success) throw new CanvasKitError('invalid_state', `${label} produced invalid state: ${parsed.error.message}`, 500);
      slot.state = parsed.data;
      slot.revision += 1;
      onChange();
      this.#publish(slot);
      return slot.state;
    };
  }

  #sender() {
    return async (message: AgentMessage) => {
      const send = this.#options.sendToAgent;
      if (!send) throw new CanvasKitError('agent_unavailable', 'No agent session is connected to this canvas', 503);
      try {
        await send(message);
      } catch (error) {
        throw new CanvasKitError('send_failed', `Could not message the agent: ${errorMessage(error)}`, 502);
      }
    };
  }

  async #parseOpenInput(input: unknown): Promise<unknown> {
    if (!this.canvas.input) return undefined;
    return parseWith(this.canvas.input, input ?? {}, `Invalid ${this.canvas.title} input`);
  }

  #persistKeyFor(instanceId: string, input: unknown): string | undefined {
    if (!this.#store || !this.canvas.persist) return undefined;
    const key = this.canvas.persist.key({ instanceId, input });
    if (typeof key !== 'string' || key.length === 0) throw new Error('persist.key() must return a non-empty string');
    return key;
  }

  async #openInstance(instanceId: string, rawInput: unknown): Promise<Instance> {
    const input = await this.#parseOpenInput(rawInput);
    const persistKey = this.#persistKeyFor(instanceId, input);
    const existing = this.#instances.get(instanceId);
    if (existing && existing.slot.persistKey === persistKey) {
      const slot = existing.slot;
      await this.#withLock(slot.lock, () => this.#reopen(slot, instanceId, input));
      return existing;
    }
    if (existing) {
      // The new input names a different document: switch this instance to it.
      await this.#detach(existing);
      await this.#attach(existing, persistKey, input);
      this.#send(existing);
      return existing;
    }

    const instance = {
      key: randomBytes(16).toString('hex'),
      token: randomBytes(32).toString('hex'),
      instanceId,
      streams: new Set<Stream>(),
    } as Instance;
    await this.#attach(instance, persistKey, input);
    this.#instances.set(instanceId, instance);
    this.#byKey.set(instance.key, instance);
    return instance;
  }

  /** Join the document for `persistKey`, loading or creating it on first use. */
  async #attach(instance: Instance, persistKey: string | undefined, input: unknown) {
    const lock = persistKey === undefined ? `s:i:${instance.instanceId}` : `s:p:${persistKey}`;
    await this.#withLock(lock, async () => {
      let slot = persistKey === undefined ? undefined : this.#slots.get(persistKey);
      if (slot) {
        await this.#reopen(slot, instance.instanceId, input);
      } else {
        const init = async () =>
          parseWith(this.canvas.state, await this.canvas.init({ instanceId: instance.instanceId, input }), 'init() returned invalid state');
        const store = persistKey === undefined ? undefined : this.#store;
        if (store && persistKey !== undefined) {
          // Load or create the document atomically, so every chat starts from the same
          // init() result and `canvas-kit run` sees documents that were only opened.
          const { document, created } = await store.lock(persistKey, async () => {
            const saved = await store.read(persistKey);
            if (saved) return { document: saved, created: false };
            const document = { state: await init(), revision: 1, jobs: {} };
            await store.write(persistKey, document);
            return { document, created: true };
          });
          slot = this.#newSlot(persistKey, document.state, document.revision, document.jobs, instance.instanceId);
          if (!created) await this.#reopen(slot, instance.instanceId, input);
        } else {
          slot = this.#newSlot(persistKey, await init(), 0, {}, instance.instanceId);
        }
        if (persistKey !== undefined) {
          this.#slots.set(persistKey, slot);
          this.#watch();
        }
      }
      slot.instances.add(instance);
      instance.slot = slot;
    });
    if (this.canvas.jobs.size > 0 && this.#options.jobs !== 'manual') {
      this.#startJobs();
      // Run overdue jobs soon after opening, without delaying the open.
      setTimeout(() => void this.tickJobs(), 0).unref();
    }
  }

  async #detach(instance: Instance) {
    const slot = instance.slot;
    await this.#withLock(slot.lock, async () => {
      slot.instances.delete(instance);
      if (slot.persistKey !== undefined && slot.instances.size === 0 && this.#slots.get(slot.persistKey) === slot) {
        this.#slots.delete(slot.persistKey);
        if (this.#slots.size === 0) this.#unwatch();
      }
    });
  }

  /**
   * Catch up with changes saved by other chats, then apply reopen(). The state is
   * saved before it becomes visible, so a failed save changes nothing.
   */
  async #reopen(slot: Slot, instanceId: string, input: unknown) {
    await this.#transact(slot, async () => {
      const next = await this.canvas.reopen({ instanceId, input, state: slot.state });
      if (next === undefined) return;
      const state = await parseWith(this.canvas.state, next, 'reopen() returned invalid state');
      await this.#persist(slot, state);
      slot.state = state;
      slot.revision += 1;
      this.#publish(slot);
    });
  }

  /** Run an action. If it throws or its state cannot be saved, the state is rolled back. */
  async #runAction(instance: Instance, request: InvokeRequest): Promise<unknown> {
    const action = this.canvas.actions.get(request.actionName);
    const hidden = action && (request.source === 'ui' ? action.expose === 'agent' : action.expose === 'ui');
    if (!action || hidden) throw new CanvasKitError('not_found', `Unknown action: ${request.actionName}`);
    const input = await parseWith(action.input, request.input ?? {}, `Invalid input for ${action.name}`);
    const slot = instance.slot;
    if (action.jobAction) return this.#jobAction(slot, action.jobAction, input as Record<string, unknown>, request.input, request.source);
    // Start from the latest saved state, holding the document so other chats' changes wait.
    return this.#transact(slot, async () => {
      const before = slot.state;
      let changed = false;
      const ctx: ActionContext<unknown> = {
        canvasId: this.canvas.id,
        instanceId: instance.instanceId,
        source: request.source,
        get state() {
          return slot.state;
        },
        dataDir: this.#dataDir,
        setState: this.#setter(slot, action.name, () => {
          changed = true;
        }) as ActionContext<unknown>['setState'],
        sendToAgent: this.#sender(),
        log: (message, level) => this.log(message, level),
        now: () => this.#now(),
      };
      try {
        const result = await action.run(ctx, input);
        if (changed) await this.#persist(slot);
        return result;
      } catch (error) {
        if (changed) {
          slot.state = before;
          slot.revision += 1;
          this.#publish(slot);
        }
        throw error;
      }
    });
  }

  #publish(slot: Slot) {
    for (const instance of slot.instances) this.#send(instance);
  }

  #send(instance: Instance) {
    const snapshot = this.#snapshotOf(instance.slot);
    for (const stream of instance.streams) stream.send(snapshot);
  }

  #stream(instance: Instance, request: IncomingMessage, response: ServerResponse) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    const heartbeat = setInterval(() => response.write(': ping\n\n'), HEARTBEAT_MS);
    heartbeat.unref();
    const stream: Stream = {
      send: snapshot => response.write(`event: state\ndata: ${JSON.stringify(snapshot)}\n\n`),
      end: () => {
        cleanup();
        response.end();
      },
    };
    const cleanup = () => {
      clearInterval(heartbeat);
      instance.streams.delete(stream);
    };
    request.on('close', cleanup);
    instance.streams.add(stream);
    stream.send(this.#snapshotOf(instance.slot));
  }

  #ensureServer() {
    this.#server ??= this.#startServer().catch(error => {
      this.#server = undefined;
      throw new CanvasKitError('listen_failed', `Cannot start the canvas server: ${errorMessage(error)}`, 500);
    });
    return this.#server;
  }

  async #startServer() {
    let origin = '';
    const server = createServer((request, response) => {
      this.#handle(request, response, origin).catch(error => this.sendError(response, error));
    });
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', fail);
        done();
      });
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { server, origin };
  }

  async #handle(request: IncomingMessage, response: ServerResponse, origin: string) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', this.#csp);
    if (request.headers.host !== new URL(origin).host) throw new CanvasKitError('forbidden', 'Invalid host');
    const requestOrigin = request.headers.origin;
    if (requestOrigin !== undefined && requestOrigin !== origin) throw new CanvasKitError('forbidden', 'Cross-origin requests are not allowed');
    if (request.method === 'POST' && requestOrigin !== origin) throw new CanvasKitError('forbidden', 'Same-origin POST required');

    const url = new URL(request.url ?? '/', origin);
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    const match = INSTANCE_PATH.exec(url.pathname);
    const instance = match && this.#byKey.get(match[1]!);
    if (!match || !instance) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('This canvas was closed. Ask the agent to reopen it.');
      return;
    }
    const rest = match[2];
    if (rest === undefined) {
      response.writeHead(308, { Location: `/c/${instance.key}/` });
      response.end();
      return;
    }
    let path: string;
    try {
      path = decodeURIComponent(rest.slice(1));
    } catch {
      throw new CanvasKitError('not_found', 'Route not found');
    }
    if (path.startsWith('__canvas/')) {
      await this.handleApi(instance.instanceId, path, request, response);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    if (path === '' || path === 'index.html') {
      let html = injectBootstrap(await this.#loadIndex(), this.#bootstrap(instance, `/c/${instance.key}/`));
      const { release } = this.#options;
      if (release && this.canvas.versionFooter) html = injectReleaseFooter(html, release);
      response.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html']! });
      response.end(request.method === 'HEAD' ? undefined : html);
      return;
    }
    await this.#sendAsset(path, request, response);
  }

  #loadIndex(): Promise<string> {
    const { uiDir } = this.#options;
    if (!uiDir) {
      return Promise.resolve(
        `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${escapeHtml(this.canvas.title)}</title></head>\n<body><div id="root"></div></body>\n</html>\n`,
      );
    }
    this.#indexHtml ??= readFile(join(uiDir, 'index.html'), 'utf8').catch(error => {
      this.#indexHtml = undefined;
      throw new CanvasKitError('not_found', `The canvas UI is missing: ${errorMessage(error)}`, 500);
    });
    return this.#indexHtml;
  }

  async #sendAsset(path: string, request: IncomingMessage, response: ServerResponse) {
    const { uiDir } = this.#options;
    const root = uiDir && resolve(uiDir);
    const file = root && resolve(root, path);
    const type = CONTENT_TYPES[extname(path).toLowerCase()];
    if (!root || !file || !file.startsWith(root + sep) || !type) {
      response.writeHead(404);
      response.end();
      return;
    }
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      response.writeHead(404);
      response.end();
      return;
    }
    const immutable = path.startsWith('assets/');
    response.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  }
}
