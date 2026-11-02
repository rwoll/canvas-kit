import react from '@vitejs/plugin-react';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { normalizePath, type EnvironmentOptions, type Plugin, type PluginOption, type ViteDevServer } from 'vite';
import type { AnyCanvas } from './define.ts';
import { CanvasKitError } from './errors.ts';
import { CanvasHost, injectBootstrap, injectTitle } from './server/host.ts';
import { escapeHtml, injectReleaseFooter, type ReleaseInfo } from './server/release.ts';

/** A plugin to publish some of the project's canvases in, apart from the main plugin. */
export interface CanvasKitPluginOptions {
  /** Kebab-case plugin name, unique in the marketplace. */
  name: string;
  description: string;
  /** Canvas folder names under `canvases/`. */
  canvases: string[];
  /** Defaults to the project's version. */
  version?: string;
}

export interface CanvasKitOptions {
  /** The main plugin's name. Defaults to the package.json name, without its scope. */
  name?: string;
  /**
   * Plugins to publish some canvases in, each installed on its own. Every other canvas
   * and the project's skills go in the main plugin.
   */
  plugins?: CanvasKitPluginOptions[];
  /** `open_canvas` input for each canvas's dev server preview, by canvas folder name. */
  devInput?: Record<string, unknown>;
}

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
}

/** One plugin the build writes to `dist/plugins/<name>`. */
interface PluginPlan {
  name: string;
  version: string;
  description: string;
  canvases: string[];
  skills: boolean;
}

const CANVASES_DIR = 'canvases';
const SKILLS_DIR = 'skills';
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEV_INSTANCE = 'dev';
const VITEST_INCLUDE = ['**/*.test.?(c|m)[jt]s?(x)'];
const VITEST_EXCLUDE = ['**/node_modules/**', '**/dist/**'];

const VIRTUAL = '\0canvas-kit:';
const CANVASES_ID = 'virtual:canvas-kit/canvases/';
const EXTENSION_ID = 'virtual:canvas-kit/extension/';
const MAIN_PATH = '/__canvas-kit/main/';

/**
 * Vite plugins for a canvas project: one package with a folder per canvas under
 * `canvases/`, each with `canvas.ts` and `App.tsx`. `vite build` writes installable
 * plugins to `dist/plugins/`; `vite` serves every canvas with its definition running
 * in-process.
 */
export function canvasKit(options: CanvasKitOptions = {}): PluginOption[] {
  // Under Vitest, run unit tests (*.test.ts); browser tests (*.spec.ts) run with `playwright test`.
  if (process.env.VITEST) {
    return [react(), { name: 'canvas-kit:vitest', config: () => ({ test: { include: VITEST_INCLUDE, exclude: VITEST_EXCLUDE } }) } as Plugin];
  }
  return [react(), canvasKitPlugin(options)];
}

/** Canvas folders under `canvases/`: those with a `canvas.ts`. */
export function findCanvases(root: string): string[] {
  const dir = join(root, CANVASES_DIR);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(dir, entry.name, 'canvas.ts')))
    .map(entry => entry.name)
    .sort();
  for (const name of names) {
    if (!NAME_PATTERN.test(name)) throw new Error(`Canvas folder names must be kebab-case: ${CANVASES_DIR}/${name}`);
    if (!existsSync(join(dir, name, 'App.tsx'))) throw new Error(`${CANVASES_DIR}/${name} has canvas.ts but no App.tsx`);
  }
  return names;
}

/** Which plugins to build and what goes in each. */
export function planPlugins(project: { name: string; version: string; description: string }, canvases: string[], hasSkills: boolean, extra: CanvasKitPluginOptions[] = []): PluginPlan[] {
  const placed = new Map<string, string>();
  const names = new Set([project.name]);
  const plans: PluginPlan[] = [];
  for (const plugin of extra) {
    if (!NAME_PATTERN.test(plugin.name ?? '')) throw new Error(`Plugin names must be kebab-case: ${plugin.name}`);
    if (names.has(plugin.name)) throw new Error(`Two plugins are named ${plugin.name}`);
    if (!plugin.description?.trim()) throw new Error(`Plugin ${plugin.name} needs a description`);
    if (!plugin.canvases?.length) throw new Error(`Plugin ${plugin.name} lists no canvases`);
    names.add(plugin.name);
    for (const canvas of plugin.canvases) {
      if (!canvases.includes(canvas)) throw new Error(`Plugin ${plugin.name} lists ${canvas}, which is not a folder in ${CANVASES_DIR}/ with a canvas.ts`);
      const other = placed.get(canvas);
      if (other) throw new Error(`${canvas} is in both ${other} and ${plugin.name}`);
      placed.set(canvas, plugin.name);
    }
    plans.push({ name: plugin.name, version: plugin.version ?? project.version, description: plugin.description, canvases: [...plugin.canvases].sort(), skills: false });
  }
  const rest = canvases.filter(canvas => !placed.has(canvas));
  // The main plugin is left out when it would be empty.
  if (rest.length > 0 || hasSkills) {
    plans.unshift({ name: project.name, version: project.version, description: project.description, canvases: rest, skills: hasSkills });
  }
  return plans;
}

/** The page for one canvas. The host adds the title, bootstrap data, and version footer when serving it. */
export function pageHtml(canvas: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '    <link rel="icon" href="data:," />',
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    `    <script type="module" src="${MAIN_PATH}${canvas}.js"></script>`,
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

const unscoped = (name: string) => name.replace(/^@[^/]+\//, '');

function canvasKitPlugin(options: CanvasKitOptions): Plugin {
  let root = process.cwd();
  let pkg: Required<PackageJson> = { name: '', version: '', description: '' };
  let canvases: string[] = [];
  let plans: PluginPlan[] = [];
  let outRoot = '';
  const devHosts = new Map<string, Promise<{ host: CanvasHost; canvas: AnyCanvas }>>();

  // Vite ids use forward slashes on every platform.
  const canvasFile = (canvas: string, file: string) => normalizePath(join(root, CANVASES_DIR, canvas, file));
  const pageId = (canvas: string) => normalizePath(join(root, `${canvas}.html`));
  const pluginFor = (canvas: string) => plans.find(plan => plan.canvases.includes(canvas))!;
  const devRelease = (canvas: string): ReleaseInfo => {
    const plan = pluginFor(canvas);
    return { name: plan.name, version: plan.version, channel: 'dev' };
  };

  const devHostFor = async (server: ViteDevServer, name: string): Promise<CanvasHost> => {
    const module = (await server.ssrLoadModule(canvasFile(name, 'canvas.ts'))) as { default?: AnyCanvas };
    const canvas = module.default;
    if (canvas?.kind !== 'canvas-kit/canvas') throw new Error(`${CANVASES_DIR}/${name}/canvas.ts must default-export defineCanvas(...)`);
    const pending = devHosts.get(name);
    const existing = await pending?.catch(() => undefined);
    if (existing?.canvas === canvas) return existing.host;
    // A request that started first may already be replacing it.
    if (devHosts.get(name) !== pending) return devHostFor(server, name);
    const next = startDevHost(server, name, canvas, existing?.host);
    devHosts.set(name, next);
    return (await next).host;
  };

  const startDevHost = async (server: ViteDevServer, name: string, canvas: AnyCanvas, previous: CanvasHost | undefined) => {
    await previous?.close();
    const host = new CanvasHost(canvas, {
      dataRoot: join(root, 'node_modules', '.canvas-dev-data'),
      release: devRelease(name),
      // There is no agent in the dev server; show what would have been sent.
      sendToAgent: async message => {
        server.config.logger.info(`[${name}] Message for the agent (${message.mode ?? 'enqueue'}):\n${message.prompt}`);
      },
      log: (message, level) => {
        const logger = server.config.logger;
        if (level === 'error') logger.error(`[${name}] ${message}`);
        else if (level === 'warning') logger.warn(`[${name}] ${message}`);
        else logger.info(`[${name}] ${message}`);
      },
    });
    // Opened once per definition, like an agent opening the canvas; page loads do not reopen it.
    await host.openLocal({ instanceId: DEV_INSTANCE, input: options.devInput?.[name] });
    return { host, canvas };
  };

  const environmentsFor = (plan: PluginPlan, index: number): Record<string, EnvironmentOptions> => {
    if (plan.canvases.length === 0) return {};
    const extensionDir = join(outRoot, plan.name, 'extensions', plan.name);
    return {
      [`ui_${index}`]: {
        consumer: 'client',
        build: {
          outDir: join(extensionDir, 'ui'),
          emptyOutDir: true,
          chunkSizeWarningLimit: 1500,
          rolldownOptions: { input: Object.fromEntries(plan.canvases.map(canvas => [canvas, pageId(canvas)])) },
        },
      },
      [`extension_${index}`]: {
        consumer: 'server',
        resolve: { noExternal: true },
        build: {
          outDir: extensionDir,
          emptyOutDir: false,
          copyPublicDir: false,
          target: 'node20',
          minify: false,
          rolldownOptions: {
            input: { extension: `${EXTENSION_ID}${plan.name}`, canvas: `${CANVASES_ID}${plan.name}` },
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
    };
  };

  const indexPage = () =>
    [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="UTF-8" /><title>Canvases</title></head>',
      '<body style="font: 15px/1.5 system-ui, sans-serif; padding: 24px">',
      '<h1>Canvases</h1>',
      canvases.length === 0
        ? `<p>No canvases yet. Add <code>${CANVASES_DIR}/&lt;name&gt;/canvas.ts</code> and <code>App.tsx</code>.</p>`
        : `<ul>${canvases.map(name => `<li><a href="/${name}/">${escapeHtml(name)}</a> <small>(${escapeHtml(pluginFor(name).name)})</small></li>`).join('')}</ul>`,
      '</body></html>',
    ].join('\n');

  return {
    name: 'canvas-kit',

    config(config) {
      root = resolve(config.root ?? process.cwd());
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;
      if (!manifest.version || !manifest.description) throw new Error(`${join(root, 'package.json')} needs a version and description`);
      const name = options.name ?? unscoped(manifest.name ?? '');
      if (!NAME_PATTERN.test(name)) throw new Error(`The plugin name must be kebab-case: "${name}". Set canvasKit({ name }) or the package.json name.`);
      pkg = { name, version: manifest.version, description: manifest.description };
      canvases = findCanvases(root);
      plans = planPlugins(pkg, canvases, existsSync(join(root, SKILLS_DIR)), options.plugins);
      // devInput is keyed by canvas folder; before projects it was one canvas's input.
      for (const key of Object.keys(options.devInput ?? {})) {
        if (!canvases.includes(key)) throw new Error(`canvasKit({ devInput }) has "${key}", which is not a canvas in ${CANVASES_DIR}/. Key it by canvas folder name: { 'my-canvas': { ... } }.`);
      }
      outRoot = join(root, 'dist', 'plugins');
      return {
        base: './',
        resolve: { dedupe: ['react', 'react-dom'] },
        // The pages and their entries are generated, so point the dependency scan at
        // the canvases' UIs; otherwise the first page load reloads to optimize React.
        optimizeDeps: { entries: [`${CANVASES_DIR}/*/App.tsx`], include: ['react', 'react-dom/client'] },
        builder: {},
        environments: Object.assign({}, ...plans.map((plan, index) => environmentsFor(plan, index))),
      };
    },

    resolveId: {
      order: 'pre',
      handler(id, importer) {
        if (id.startsWith(CANVASES_ID) || id.startsWith(EXTENSION_ID)) return `${VIRTUAL}${id}`;
        if (id.startsWith(MAIN_PATH)) return `${VIRTUAL}${id}`;
        const page = canvases.find(canvas => id === pageId(canvas));
        if (page) return id;
        const fromSource = importer && !importer.includes(`${sep}node_modules${sep}`) && !importer.startsWith('\0');
        if (this.environment.config.consumer === 'client' && fromSource && (id.startsWith('node:') || isBuiltin(id))) {
          this.error(
            `${importer} imports the Node.js module "${id}". UI code runs in the browser; ` +
              'move Node.js work into the canvas actions and use `import type` for canvas.ts.',
          );
        }
        return undefined;
      },
    },

    load(id) {
      const page = canvases.find(canvas => id === pageId(canvas));
      if (page) return pageHtml(page);
      if (!id.startsWith(VIRTUAL)) return undefined;
      const virtual = id.slice(VIRTUAL.length);
      if (virtual.startsWith(MAIN_PATH)) {
        const name = virtual.slice(MAIN_PATH.length).replace(/\.js$/, '');
        if (!canvases.includes(name)) return undefined;
        return [
          "import { StrictMode, createElement } from 'react';",
          "import { createRoot } from 'react-dom/client';",
          "import '@rwoll/canvas-kit/styles.css';",
          `import App from ${JSON.stringify(canvasFile(name, 'App.tsx'))};`,
          "createRoot(document.getElementById('root')).render(createElement(StrictMode, null, createElement(App)));",
          '',
        ].join('\n');
      }
      if (virtual.startsWith(CANVASES_ID)) {
        const plan = plans.find(candidate => candidate.name === virtual.slice(CANVASES_ID.length));
        if (!plan) return undefined;
        return [
          "import { runPluginJob } from '@rwoll/canvas-kit/server';",
          ...plan.canvases.map((canvas, index) => `import canvas${index} from ${JSON.stringify(canvasFile(canvas, 'canvas.ts'))};`),
          '/** The canvases in this plugin, by folder name, with the page each one serves. */',
          `export const canvases = [${plan.canvases.map((canvas, index) => `{ name: ${JSON.stringify(canvas)}, page: ${JSON.stringify(`${canvas}.html`)}, canvas: canvas${index} }`).join(', ')}];`,
          '/** Run scheduled jobs for saved documents with no chat open; see `canvas-kit run`. */',
          'export function runJob(job, options) {',
          '  return runPluginJob(canvases, job, options);',
          '}',
          '',
        ].join('\n');
      }
      if (virtual.startsWith(EXTENSION_ID)) {
        const plan = plans.find(candidate => candidate.name === virtual.slice(EXTENSION_ID.length));
        if (!plan) return undefined;
        return [
          "import { runCanvasExtension } from '@rwoll/canvas-kit/extension';",
          `import { canvases } from ${JSON.stringify(`${CANVASES_ID}${plan.name}`)};`,
          'await runCanvasExtension(canvases, {',
          "  uiDir: new URL('./ui/', import.meta.url),",
          "  releaseFile: new URL('../../release.json', import.meta.url),",
          `  plugin: ${JSON.stringify({ name: plan.name, version: plan.version })},`,
          '});',
          '',
        ].join('\n');
      }
      return undefined;
    },

    buildApp: {
      order: 'pre',
      async handler(builder) {
        await rm(outRoot, { recursive: true, force: true });
        if (plans.length === 0) builder.config.logger.warn(`[canvas-kit] No canvases in ${CANVASES_DIR}/ and no ${SKILLS_DIR}/, so there is no plugin to build.`);
        for (const [index, plan] of plans.entries()) {
          const pluginDir = join(outRoot, plan.name);
          if (plan.canvases.length > 0) {
            await builder.build(builder.environments[`ui_${index}`]!);
            await builder.build(builder.environments[`extension_${index}`]!);
          }
          if (plan.skills) await cp(join(root, SKILLS_DIR), join(pluginDir, SKILLS_DIR), { recursive: true });
          const manifest = {
            name: plan.name,
            version: plan.version,
            description: plan.description,
            ...(plan.skills && { skills: `${SKILLS_DIR}/` }),
            ...(plan.canvases.length > 0 && { extensions: 'extensions/' }),
          };
          await mkdir(join(pluginDir, '.plugin'), { recursive: true });
          await writeFile(join(pluginDir, '.plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        }
        // Vite builds every environment when no plugin built one, and a project has no
        // index.html for the default ones, so mark them done.
        for (const environment of Object.values(builder.environments)) environment.isBuilt = true;
      },
    },

    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (path === '/' || path === '/index.html') {
          if (canvases.length === 1) {
            response.writeHead(302, { Location: `/${canvases[0]}/` });
            response.end();
            return;
          }
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end(indexPage());
          return;
        }
        const match = /^\/([a-z0-9-]+)(\/.*)?$/.exec(path);
        const name = match && canvases.includes(match[1]!) ? match[1]! : undefined;
        if (!name) {
          next();
          return;
        }
        const rest = match![2];
        if (rest === undefined) {
          response.writeHead(308, { Location: `/${name}/` });
          response.end();
          return;
        }
        if (rest !== '/' && !rest.startsWith('/__canvas/')) {
          next();
          return;
        }
        void (async () => {
          let host: CanvasHost | undefined;
          try {
            host = await devHostFor(server, name);
            if (rest === '/') {
              const base = `/${name}/`;
              let html = await server.transformIndexHtml(base, pageHtml(name));
              html = injectTitle(injectBootstrap(html, host.bootstrapFor(DEV_INSTANCE, base)!), host.canvas.title);
              if (host.canvas.versionFooter) html = injectReleaseFooter(html, devRelease(name));
              response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
              response.end(html);
              return;
            }
            if (request.method === 'POST' && request.headers.origin !== `http://${request.headers.host}`) {
              throw new CanvasKitError('forbidden', 'Same-origin POST required');
            }
            // Dev only: act as the agent, for example to preview a summary the UI cannot create.
            const agentAction = /^\/__canvas\/dev\/agent\/([a-z][a-z0-9_]*)$/.exec(rest);
            if (agentAction && request.method === 'POST') {
              await host.runDevAgentAction(DEV_INSTANCE, agentAction[1]!, request, response);
              return;
            }
            await host.handleApi(DEV_INSTANCE, rest.slice(1), request, response);
          } catch (error) {
            if (host) host.sendError(response, error);
            else next(error);
          }
        })();
      });
      // A new or removed canvas changes the pages and plugins, so start over.
      const restartOn = (file: string) => {
        const rel = relative(join(root, CANVASES_DIR), file).split(/[\\/]/);
        if (rel.length === 2 && (rel[1] === 'canvas.ts' || rel[1] === 'App.tsx')) void server.restart();
      };
      server.watcher.on('add', restartOn);
      server.watcher.on('unlink', restartOn);
      server.watcher.on('change', file => {
        // The canvas definition runs on the server, so reload pages to pick up its changes.
        if (normalizePath(file).startsWith(`${normalizePath(join(root, CANVASES_DIR))}/`) && !/\.(tsx|css)$/.test(file)) server.ws.send({ type: 'full-reload' });
      });
      server.httpServer?.once('close', () => {
        for (const pending of devHosts.values()) void pending.then(({ host }) => host.close(), () => {});
      });
    },
  };
}
