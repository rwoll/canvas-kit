import { jobForId, type AnyCanvas, type LogLevel } from '../define.ts';
import { CanvasKitError, errorMessage } from '../errors.ts';
import { CanvasHost, type JobOutcome } from './host.ts';

export interface RunCanvasJobOptions {
  /** Run jobs for this saved document only. Defaults to every saved document. */
  key?: string;
  /** Run even if not due or paused. */
  force?: boolean;
  /** Parent of the per-canvas data folders. Defaults to `<copilot-home>/extension-data`. */
  dataRoot?: string;
  log?: (message: string, level: LogLevel) => void;
}

/**
 * Run scheduled jobs for saved documents with no chat or agent, as `canvas-kit run`
 * does. `job` selects every job (undefined), the jobs with one name (including those
 * added from a job with input), or the job with one ID. Each runs only when due and
 * not paused (unless `force`), under the same lock chats use, so it is safe while
 * chats have the canvas open.
 */
export async function runCanvasJob(canvas: AnyCanvas, job?: string, options: RunCanvasJobOptions = {}): Promise<JobOutcome[]> {
  if (job !== undefined) jobForId(canvas, job);
  if (!canvas.persist) {
    throw new CanvasKitError('invalid_input', `${canvas.title} does not save documents, so its jobs run only while a chat has it open.`);
  }
  const host = new CanvasHost(canvas, { dataRoot: options.dataRoot, jobs: 'manual', watch: false, log: options.log });
  try {
    const keys = options.key !== undefined ? [options.key] : await host.savedKeys();
    const outcomes: JobOutcome[] = [];
    for (const key of keys) {
      try {
        outcomes.push(...(await host.runJobs(job, { key, force: options.force ?? false, headless: true })));
      } catch (error) {
        outcomes.push({ id: job ?? '*', job: job ?? '*', key, ran: false, error: errorMessage(error) });
      }
    }
    return outcomes;
  } finally {
    await host.close();
  }
}

/** A canvas in a built plugin, as its generated `canvas.mjs` lists it. */
export interface PluginCanvasEntry {
  /** The canvas's folder name. */
  name: string;
  canvas: AnyCanvas;
}

/** The canvas a selector names, by folder name or canvas ID, or the only one. */
export function pickCanvas<E extends PluginCanvasEntry>(entries: readonly E[], selector?: string): E {
  const names = entries.map(entry => entry.name).join(', ');
  if (selector === undefined) {
    if (entries.length === 1) return entries[0]!;
    throw new CanvasKitError('invalid_input', `This plugin has several canvases (${names}); pass the one to run, such as --canvas ${entries[0]?.name}.`);
  }
  const entry = entries.find(candidate => candidate.name === selector || candidate.canvas.id === selector);
  if (!entry) throw new CanvasKitError('not_found', `No canvas ${selector} in this plugin. Its canvases: ${names}.`);
  return entry;
}

/**
 * Run scheduled jobs for one canvas of a built plugin, as its `canvas.mjs` does for
 * `canvas-kit run`. `options.canvas` picks the canvas by folder name or ID.
 */
export function runPluginJob(entries: readonly PluginCanvasEntry[], job?: string, options: RunCanvasJobOptions & { canvas?: string } = {}): Promise<JobOutcome[]> {
  const { canvas, ...rest } = options;
  return runCanvasJob(pickCanvas(entries, canvas).canvas, job, rest);
}
