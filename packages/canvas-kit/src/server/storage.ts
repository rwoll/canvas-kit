import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { z } from 'zod';
import { CanvasKitError, errorMessage } from '../errors.ts';

const FORMAT = 'rwoll-canvas-kit-state';

/** `$COPILOT_HOME` when set, otherwise `~/.copilot`. */
export function copilotHome(): string {
  const home = process.env.COPILOT_HOME;
  return typeof home === 'string' && home.length > 0 ? home : join(homedir(), '.copilot');
}

/** Private data folder shared by every host and workspace for one canvas ID. */
export function canvasDataDir(canvasId: string, dataRoot = join(copilotHome(), 'extension-data')): string {
  return join(dataRoot, canvasId);
}

/** One job's schedule and run history for one document, keyed by the job's ID. */
export interface JobRecord {
  /** The job it was added from, for a job added from a job with input. */
  job?: string;
  /** The input it was added with. */
  input?: unknown;
  /** An interval chosen by a user, in milliseconds. */
  every?: number;
  /** False while paused. */
  enabled?: boolean;
  createdAt?: string;
  lastRunAt?: string;
  /** The error from the last run, when it failed. */
  lastError?: string;
}

/** A saved document: its state, a revision that increases on every save, and its job records. */
export interface StoredDocument {
  state: unknown;
  revision: number;
  jobs: Record<string, JobRecord>;
}

interface SavedState {
  format: typeof FORMAT;
  version: number;
  key: string;
  savedAt: string;
  /** Increases on every save, so a process can tell its copy is stale. Missing in files older than 0.2. */
  revision?: number;
  jobs?: Record<string, JobRecord>;
  state: unknown;
}

export interface StateStoreOptions {
  /** How long to wait for another process's lock before failing with `busy`. */
  lockWaitMs?: number;
  /** A lock whose holder stopped refreshing it this long ago is taken over. */
  lockStaleMs?: number;
}

/** A lock holder refreshes its lock file this often; see `lockStaleMs`. */
const LOCK_REFRESH_MS = 5_000;
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return code(error) === 'EPERM';
  }
}

/**
 * Saves one JSON file per domain key with atomic replacement and validated reads.
 * Every process that opens the same key shares the file; `lock()` serializes their
 * changes so no update is lost.
 */
export class StateStore {
  readonly dir: string;
  readonly #schema: z.ZodType;
  readonly #version: number;
  readonly #lockWaitMs: number;
  readonly #lockStaleMs: number;

  constructor(dir: string, schema: z.ZodType, version: number, options: StateStoreOptions = {}) {
    this.dir = dir;
    this.#schema = schema;
    this.#version = version;
    this.#lockWaitMs = options.lockWaitMs ?? 30_000;
    this.#lockStaleMs = options.lockStaleMs ?? 15_000;
  }

  /** The folder with the saved documents. */
  get stateDir(): string {
    return join(this.dir, 'state');
  }

  fileFor(key: string): string {
    return join(this.stateDir, `${createHash('sha256').update(key).digest('hex').slice(0, 40)}.json`);
  }

  /** The state of the document for `key`, or undefined when none is saved. */
  async load(key: string): Promise<unknown> {
    return (await this.read(key))?.state;
  }

  /** The saved document for `key` with its revision and job records, or undefined. */
  async read(key: string): Promise<StoredDocument | undefined> {
    const file = this.fileFor(key);
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new CanvasKitError('storage_error', `Cannot read ${file}: ${errorMessage(error)}`);
    }
    let saved: Partial<SavedState>;
    try {
      saved = JSON.parse(content) as Partial<SavedState>;
    } catch {
      throw new CanvasKitError('corrupt_state', `${file} is not valid JSON. Move it aside to start fresh.`);
    }
    if (saved?.format !== FORMAT || typeof saved.version !== 'number') {
      throw new CanvasKitError('corrupt_state', `${file} is not canvas state. Move it aside to start fresh.`);
    }
    if (saved.version !== this.#version) {
      throw new CanvasKitError(
        'unsupported_state',
        `${file} has state version ${saved.version}, but this canvas reads version ${this.#version}. Move it aside to start fresh.`,
      );
    }
    if (saved.key !== key) {
      throw new CanvasKitError('corrupt_state', `${file} belongs to a different key. Move it aside to start fresh.`);
    }
    const parsed = await this.#schema.safeParseAsync(saved.state);
    if (!parsed.success) {
      throw new CanvasKitError('corrupt_state', `${file} does not match the canvas state schema. Move it aside to start fresh.`);
    }
    return { state: parsed.data, revision: typeof saved.revision === 'number' ? saved.revision : 0, jobs: saved.jobs ?? {} };
  }

  /** Save `state` as the next revision, keeping job records. Takes the document's lock. */
  async save(key: string, state: unknown): Promise<void> {
    await this.lock(key, async () => {
      const current = await this.read(key).catch(() => undefined);
      await this.write(key, { state, revision: (current?.revision ?? 0) + 1, jobs: current?.jobs ?? {} });
    });
  }

  /** Replace the saved document. Call it while holding `lock(key)`. */
  async write(key: string, document: StoredDocument): Promise<void> {
    const file = this.fileFor(key);
    const folder = join(file, '..');
    const temp = join(folder, `.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    const saved: SavedState = {
      format: FORMAT,
      version: this.#version,
      key,
      savedAt: new Date().toISOString(),
      revision: document.revision,
      ...(Object.keys(document.jobs).length > 0 && { jobs: document.jobs }),
      state: document.state,
    };
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(temp, `${JSON.stringify(saved, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temp, file);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw new CanvasKitError('storage_error', `Cannot save ${file}: ${errorMessage(error)}`);
    }
  }

  /** The keys of every saved document, for running jobs without an open canvas. */
  async keys(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.stateDir);
    } catch (error) {
      if (code(error) === 'ENOENT') return [];
      throw new CanvasKitError('storage_error', `Cannot list ${this.stateDir}: ${errorMessage(error)}`);
    }
    const keys: string[] = [];
    for (const name of names.filter(entry => /^[0-9a-f]{40}\.json$/.test(entry)).sort()) {
      try {
        const saved = JSON.parse(await readFile(join(this.stateDir, name), 'utf8')) as Partial<SavedState>;
        if (saved.format === FORMAT && typeof saved.key === 'string' && basename(this.fileFor(saved.key)) === name) keys.push(saved.key);
      } catch {
        // Unreadable files are reported when the document is opened.
      }
    }
    return keys;
  }

  /**
   * Run `work` while holding the document's lock across processes, so changes from
   * every chat that has the document open apply one at a time. The lock is a file
   * next to the document. Its holder refreshes it while working; a lock whose holder
   * exited, or stopped refreshing it, is taken over.
   */
  async lock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const file = `${this.fileFor(key)}.lock`;
    const nonce = randomBytes(8).toString('hex');
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.#lockWaitMs;
    for (let delay = 2; ; delay = Math.min(delay * 2, 100)) {
      try {
        const handle = await open(file, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, nonce }));
          await handle.close();
        } catch (error) {
          // Never leave an empty lock behind, for example when the disk is full.
          await handle.close().catch(() => {});
          await unlink(file).catch(() => {});
          throw error;
        }
        break;
      } catch (error) {
        if (code(error) !== 'EEXIST') throw new CanvasKitError('storage_error', `Cannot lock ${file}: ${errorMessage(error)}`);
      }
      if (await this.#takeOverIfStale(file)) continue;
      if (Date.now() > deadline) {
        throw new CanvasKitError('busy', 'Another chat is still changing this document. Try again in a moment.', 409);
      }
      await sleep(delay);
    }
    const refresh = setInterval(() => {
      const now = new Date();
      void utimes(file, now, now).catch(() => {});
    }, LOCK_REFRESH_MS);
    refresh.unref();
    try {
      return await work();
    } finally {
      clearInterval(refresh);
      await this.#release(file, nonce);
    }
  }

  async #release(file: string, nonce: string) {
    try {
      const holder = JSON.parse(await readFile(file, 'utf8')) as { nonce?: string };
      // Only remove our own lock; another process may have taken over a lock we held too long.
      if (holder.nonce === nonce) await unlink(file);
    } catch {
      // Already gone.
    }
  }

  /** Remove a lock whose holder exited or went quiet. Returns true when the caller should retry at once. */
  async #takeOverIfStale(file: string): Promise<boolean> {
    let holder: { pid?: number; nonce?: string };
    let age: number;
    try {
      const [content, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      age = Date.now() - info.mtimeMs;
      try {
        holder = JSON.parse(content) as typeof holder;
      } catch {
        // Not written yet by a holder that just created it, or left empty by one that
        // crashed: treat it like any other lock and take it over once it is stale.
        holder = {};
      }
    } catch (error) {
      // Released while we looked.
      return code(error) === 'ENOENT';
    }
    const exited = typeof holder.pid === 'number' && holder.pid !== process.pid && !alive(holder.pid);
    if (!exited && age < this.#lockStaleMs) return false;
    // Move the stale lock aside, then check it is the one we judged stale before deleting it.
    const aside = `${file}.${randomBytes(6).toString('hex')}.stale`;
    try {
      await rename(file, aside);
    } catch {
      return true;
    }
    try {
      const moved = JSON.parse(await readFile(aside, 'utf8')) as typeof holder;
      if (moved.nonce !== holder.nonce) {
        // Someone took the lock over first and we moved their fresh lock; put it back.
        await link(aside, file).catch(() => {});
      }
    } catch {
      // Unreadable: it was stale.
    }
    await unlink(aside).catch(() => {});
    return true;
  }
}
