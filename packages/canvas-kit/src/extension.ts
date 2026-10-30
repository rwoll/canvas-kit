import { CanvasError, createCanvas, joinSession, type CanvasJsonSchema } from '@github/copilot-sdk/extension';
import { fileURLToPath } from 'node:url';
import type { AnyCanvas, LogLevel } from './define.ts';
import { CanvasKitError, errorMessage } from './errors.ts';
import { CanvasHost } from './server/host.ts';
import { loadRelease } from './server/release.ts';

export interface RunCanvasExtensionOptions {
  /** Folder with the built UI, usually `new URL('./ui/', import.meta.url)`. */
  uiDir: URL | string;
  /** Plugin name and version, embedded at build time. */
  plugin: { name: string; version: string };
  /** Release stamp written by `canvas-kit release`, usually `<plugin>/release.json`. */
  releaseFile: URL | string;
}

/** What `runCanvasExtension` returns: the joined session and the canvas host. */
export interface RunningCanvasExtension {
  session: Awaited<ReturnType<typeof joinSession>>;
  host: CanvasHost;
}

const toPath = (value: URL | string) => (typeof value === 'string' ? value : fileURLToPath(value));

function toCanvasError(error: unknown): CanvasError {
  if (error instanceof CanvasError) return error;
  if (error instanceof CanvasKitError) return new CanvasError(error.code, error.message);
  return new CanvasError('extension_error', errorMessage(error));
}

const guard = <T>(run: () => T | Promise<T>): Promise<T> =>
  Promise.resolve()
    .then(run)
    .catch(error => {
      throw toCanvasError(error);
    });

/**
 * Register a canvas with the current Copilot session. The kit's Vite build
 * generates the extension entry that calls this; canvases do not call it directly.
 */
export async function runCanvasExtension(canvas: AnyCanvas, options: RunCanvasExtensionOptions): Promise<RunningCanvasExtension> {
  let session: Awaited<ReturnType<typeof joinSession>> | undefined;
  const log = (message: string, level: LogLevel) => {
    if (!session) return;
    Promise.resolve(session.log(message, { level })).catch(() => {});
  };
  const { release, warning } = await loadRelease(toPath(options.releaseFile), options.plugin);
  const host = new CanvasHost(canvas, {
    uiDir: toPath(options.uiDir),
    release,
    log,
    sendToAgent: async message => {
      if (!session) throw new Error('The canvas has not joined a session yet');
      await session.send(message);
    },
  });

  session = await joinSession({
    canvases: [
      createCanvas({
        id: canvas.id,
        displayName: canvas.title,
        description: canvas.description,
        ...(canvas.inputJsonSchema ? { inputSchema: canvas.inputJsonSchema as CanvasJsonSchema } : {}),
        actions: [...canvas.actions.values()]
          .filter(action => action.expose !== 'ui')
          .map(action => ({
            name: action.name,
            description: action.description,
            inputSchema: action.inputJsonSchema as CanvasJsonSchema,
            handler: ctx =>
              guard(() => host.invoke({ instanceId: ctx.instanceId, actionName: action.name, input: ctx.input, source: 'agent' })),
          })),
        open: ctx => guard(() => host.open({ instanceId: ctx.instanceId, input: ctx.input })),
        onClose: ctx => guard(() => host.closeInstance(ctx.instanceId)),
      }),
    ],
  });

  if (warning) log(warning, 'warning');

  const shutdown = () => {
    host.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return { session, host };
}
