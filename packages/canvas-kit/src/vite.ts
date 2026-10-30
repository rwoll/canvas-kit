import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { basename, join, resolve, sep } from 'node:path';
import type { Plugin, PluginOption, ViteDevServer } from 'vite';
import type { AnyCanvas } from './define.ts';
import { CanvasKitError } from './errors.ts';
import { CanvasHost, injectBootstrap } from './server/host.ts';
import { injectReleaseFooter, type ReleaseInfo } from './server/release.ts';

export interface CanvasKitOptions {
  /** Module whose default export is the `defineCanvas()` result, relative to the Vite root. */
  entry?: string;
  /** Plugin and extension folder name. Defaults to the canvas package folder name. */
  name?: string;
  /** `open_canvas` input for the dev server's preview instance. */
  devInput?: unknown;
}

const ENTRY_ID = 'virtual:canvas-kit/extension-entry';
const RESOLVED_ENTRY_ID = `\0${ENTRY_ID}`;
// canvas.mjs: the definition and a headless job runner, loadable without the Copilot SDK.
const CANVAS_ENTRY_ID = 'virtual:canvas-kit/canvas-entry';
const RESOLVED_CANVAS_ENTRY_ID = `\0${CANVAS_ENTRY_ID}`;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEV_INSTANCE = 'dev';
const VITEST_EXCLUDE = ['**/node_modules/**', '**/dist/**', 'e2e/**'];

interface PackageJson {
  version?: string;
  description?: string;
}

/**
 * Vite plugins for a canvas package. `vite build` writes an installable plugin to
 * `dist/plugin/`; `vite` serves the UI with the canvas definition running in-process.
 */
export function canvasKit(options: CanvasKitOptions = {}): PluginOption[] {
  // Under Vitest, skip the Playwright specs in e2e/; they run with `playwright test`.
  if (process.env.VITEST) return [react(), { name: 'canvas-kit:vitest', config: () => ({ test: { exclude: VITEST_EXCLUDE } }) } as Plugin];
  return [react(), canvasKitPlugin(options)];
}

function canvasKitPlugin(options: CanvasKitOptions): Plugin {
  let root = process.cwd();
  let name = '';
  let pkg: Required<PackageJson> = { version: '', description: '' };
  let entry = '';
  let outRoot = '';
  let devServer: ViteDevServer | undefined;
  let devHost: CanvasHost | undefined;
  let devCanvas: AnyCanvas | undefined;

  const devRelease = (): ReleaseInfo => ({ name, version: pkg.version, channel: 'dev' });

  const devHostFor = async (server: ViteDevServer) => {
    const module = (await server.ssrLoadModule(entry)) as { default?: AnyCanvas };
    const canvas = module.default;
    if (canvas?.kind !== 'canvas-kit/canvas') throw new Error(`${entry} must default-export defineCanvas(...)`);
    if (!devHost || canvas !== devCanvas) {
      await devHost?.close();
      devCanvas = canvas;
      devHost = new CanvasHost(canvas, {
        dataRoot: join(root, 'node_modules', '.canvas-dev-data'),
        release: devRelease(),
        // There is no agent in the dev server; show what would have been sent.
        sendToAgent: async message => {
          server.config.logger.info(`[canvas] Message for the agent (${message.mode ?? 'enqueue'}):\n${message.prompt}`);
        },
        log: (message, level) => {
          const logger = server.config.logger;
          if (level === 'error') logger.error(`[canvas] ${message}`);
          else if (level === 'warning') logger.warn(`[canvas] ${message}`);
          else logger.info(`[canvas] ${message}`);
        },
      });
      // Opened once per definition, like an agent opening the canvas; page loads do not reopen it.
      await devHost.openLocal({ instanceId: DEV_INSTANCE, input: options.devInput });
    }
    return devHost;
  };

  return {
    name: 'canvas-kit',

    config(config) {
      root = resolve(config.root ?? process.cwd());
      name = options.name ?? basename(root);
      if (!NAME_PATTERN.test(name)) throw new Error(`Canvas plugin name must be kebab-case: ${name}`);
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;
      if (!manifest.version || !manifest.description) throw new Error(`${join(root, 'package.json')} needs a version and description`);
      pkg = { version: manifest.version, description: manifest.description };
      entry = resolve(root, options.entry ?? 'server/canvas.ts');
      outRoot = join(root, 'dist', 'plugin');
      const extensionDir = join(outRoot, 'extensions', name);
      return {
        base: './',
        resolve: { dedupe: ['react', 'react-dom'] },
        build: { outDir: join(extensionDir, 'ui'), emptyOutDir: true, chunkSizeWarningLimit: 1500 },
        builder: {},
        environments: {
          extension: {
            consumer: 'server',
            resolve: { noExternal: true },
            build: {
              outDir: extensionDir,
              emptyOutDir: false,
              copyPublicDir: false,
              target: 'node20',
              minify: false,
              rolldownOptions: {
                input: { extension: ENTRY_ID, canvas: CANVAS_ENTRY_ID },
                // The Copilot host injects its own SDK copy at runtime.
                external: [/^@github\/copilot-sdk(?:\/|$)/],
                output: {
                  format: 'es',
                  entryFileNames: '[name].mjs',
                  chunkFileNames: 'chunks/[name]-[hash].mjs',
                },
              },
            },
          },
        },
      };
    },

    resolveId: {
      order: 'pre',
      handler(id, importer) {
        if (id === ENTRY_ID) return RESOLVED_ENTRY_ID;
        if (id === CANVAS_ENTRY_ID) return RESOLVED_CANVAS_ENTRY_ID;
        const fromSource = importer && !importer.includes(`${sep}node_modules${sep}`) && !importer.startsWith('\0');
        if (this.environment.config.consumer === 'client' && fromSource && (id.startsWith('node:') || isBuiltin(id))) {
          this.error(
            `${importer} imports the Node.js module "${id}". UI code runs in the browser; ` +
              'move Node.js work into the canvas actions and use `import type` for server modules.',
          );
        }
        return undefined;
      },
    },

    load(id) {
      if (id === RESOLVED_CANVAS_ENTRY_ID) {
        return [
          "import { runCanvasJob } from '@rwoll/canvas-kit/server';",
          `import canvas from ${JSON.stringify(entry)};`,
          'export default canvas;',
          '/** Run a scheduled job for saved documents with no chat open; see `canvas-kit run`. */',
          'export function runJob(job, options) {',
          '  return runCanvasJob(canvas, job, options);',
          '}',
          '',
        ].join('\n');
      }
      if (id !== RESOLVED_ENTRY_ID) return undefined;
      return [
        "import { runCanvasExtension } from '@rwoll/canvas-kit/extension';",
        `import canvas from ${JSON.stringify(CANVAS_ENTRY_ID)};`,
        'await runCanvasExtension(canvas, {',
        "  uiDir: new URL('./ui/', import.meta.url),",
        "  releaseFile: new URL('../../release.json', import.meta.url),",
        `  plugin: ${JSON.stringify({ name, version: pkg.version })},`,
        '});',
        '',
      ].join('\n');
    },

    buildApp: {
      order: 'pre',
      async handler(builder) {
        await rm(outRoot, { recursive: true, force: true });
        await builder.build(builder.environments.client!);
        await builder.build(builder.environments.extension!);
        const manifest = { name, version: pkg.version, description: pkg.description, extensions: 'extensions/' };
        await mkdir(join(outRoot, '.plugin'), { recursive: true });
        await writeFile(join(outRoot, '.plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      },
    },

    configureServer(server) {
      devServer = server;
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (!path.startsWith('/__canvas/')) {
          next();
          return;
        }
        void (async () => {
          let host: CanvasHost | undefined;
          try {
            host = await devHostFor(server);
            if (request.method === 'POST' && request.headers.origin !== `http://${request.headers.host}`) {
              throw new CanvasKitError('forbidden', 'Same-origin POST required');
            }
            // Dev only: act as the agent, for example to preview a tour or proposal the UI cannot create.
            const agentAction = /^\/__canvas\/dev\/agent\/([a-z][a-z0-9_]*)$/.exec(path);
            if (agentAction && request.method === 'POST') {
              await host.runDevAgentAction(DEV_INSTANCE, agentAction[1]!, request, response);
              return;
            }
            await host.handleApi(DEV_INSTANCE, path.slice(1), request, response);
          } catch (error) {
            if (host) host.sendError(response, error);
            else next(error);
          }
        })();
      });
      server.watcher.on('change', file => {
        if (file.startsWith(join(root, 'server') + sep)) server.ws.send({ type: 'full-reload' });
      });
      server.httpServer?.once('close', () => void devHost?.close());
    },

    transformIndexHtml: {
      order: 'pre',
      async handler(html, ctx) {
        if (!ctx.server || !devServer) return html;
        const host = await devHostFor(devServer);
        const bootstrap = host.bootstrapFor(DEV_INSTANCE, '/');
        const page = bootstrap ? injectBootstrap(html, bootstrap) : html;
        return devCanvas?.versionFooter ? injectReleaseFooter(page, devRelease()) : page;
      },
    },
  };
}
