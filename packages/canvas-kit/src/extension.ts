import { CanvasError, createCanvas, joinSession, type CanvasJsonSchema } from '@github/copilot-sdk/extension';
import { fileURLToPath } from 'node:url';
import type { AnyCanvas, LogLevel } from './define.ts';
import { CanvasKitError, errorMessage } from './errors.ts';
import type { CanvasSession } from './server/activity.ts';
import { CanvasHost } from './server/host.ts';
import { loadRelease } from './server/release.ts';

/** A canvas in a plugin, with the page its UI is built to. */
export interface PluginCanvas {
  /** The canvas's folder name. */
  name: string;
  canvas: AnyCanvas;
  /** Its page in the UI folder, such as `release-board.html`. Defaults to `index.html`. */
  page?: string;
}

export interface RunCanvasExtensionOptions {
  /** Folder with the built UI, usually `new URL('./ui/', import.meta.url)`. */
  uiDir: URL | string;
  /** Plugin name and version, embedded at build time. */
  plugin: { name: string; version: string };
  /** Release stamp written by `canvas-kit release`, usually `<plugin>/release.json`. */
  releaseFile: URL | string;
}

/** What `runCanvasExtension` returns: the joined session and a host for each canvas. */
export interface RunningCanvasExtension {
  session: Awaited<ReturnType<typeof joinSession>>;
  hosts: CanvasHost[];
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
 * Register a plugin's canvases with the current Copilot session, in one process.
 * The kit's Vite build generates the extension entry that calls this; canvases do
 * not call it directly.
 */
export async function runCanvasExtension(
  canvases: AnyCanvas | readonly (AnyCanvas | PluginCanvas)[],
  options: RunCanvasExtensionOptions,
): Promise<RunningCanvasExtension> {
  const entries = (Array.isArray(canvases) ? canvases : [canvases]).map((entry: AnyCanvas | PluginCanvas) =>
    'kind' in entry ? { canvas: entry, page: undefined } : entry,
  );
  const ids = new Set<string>();
  for (const { canvas } of entries) {
    if (ids.has(canvas.id)) throw new Error(`Two canvases in ${options.plugin.name} have the ID ${canvas.id}`);
    ids.add(canvas.id);
  }

  let session: Awaited<ReturnType<typeof joinSession>> | undefined;
  const log = (message: string, level: LogLevel) => {
    if (!session) return;
    Promise.resolve(session.log(message, { level })).catch(() => {});
  };
  const { release, warning } = await loadRelease(toPath(options.releaseFile), options.plugin);
  let joined!: (session: CanvasSession) => void;
  const sessionReady = new Promise<CanvasSession>(resolve => {
    joined = resolve;
  });
  const hosts = entries.map(
    ({ canvas, page }) =>
      new CanvasHost(canvas, {
        uiDir: toPath(options.uiDir),
        ...(page && { indexFile: page }),
        release,
        log,
        session: sessionReady,
        sendToAgent: async message => {
          if (!session) throw new Error('The canvas has not joined a session yet');
          return session.send(message);
        },
      }),
  );

  session = await joinSession({
    canvases: hosts.map(host => {
      const { canvas } = host;
      return createCanvas({
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
      });
    }),
  });

  if (warning) log(warning, 'warning');
  const joinedSession = session;
  joined({
    sessionId: joinedSession.sessionId,
    on: handler => joinedSession.on(handler),
    getEvents: () => joinedSession.getEvents(),
  });

  const shutdown = () => {
    Promise.allSettled(hosts.map(host => host.close())).finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return { session, hosts };
}
