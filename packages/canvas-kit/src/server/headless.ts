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
