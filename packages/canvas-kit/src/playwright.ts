import { defineConfig, devices, test as base, type Page, type PlaywrightTestConfig } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { AgentMessage, AnyCanvas, JobName, StateOf } from './define.ts';
import type { JobOutcome, RunJobOptions } from './server/host.ts';
import type { ReleaseInfo } from './server/release.ts';
import { StateStore, canvasDataDir } from './server/storage.ts';
import { createTestCanvas, type HarnessAction, type HarnessInput, type HarnessResult, type TestCanvas } from './testing.ts';

export interface CanvasTestOptions {
  /**
   * The canvas's folder name under `canvases/`. Defaults to the folder of the spec
   * file, or the nearest folder above it with a `canvas.ts`.
   */
  name?: string;
  /**
   * Folder with the built UI. Defaults to the one in `dist/plugins/` that has the
   * canvas's page, which is what `vite build` writes.
   */
  uiDir?: string;
  /**
   * Release shown in the version footer. Defaults to an unpublished build of the
   * plugin the canvas is built into, so screenshots stay stable.
   */
  release?: ReleaseInfo;
  /** Clock for actions and jobs (`ctx.now()`), to test time-based jobs. Defaults to `Date.now`. */
  now?: () => number;
}

export interface OpenedCanvas<C extends AnyCanvas> {
  /** The page showing the canvas, already live. */
  page: Page;
  url: string;
  instanceId: string;
  /** The instance's current state on the server. */
  state(): StateOf<C> | undefined;
  /** Open the same instance in another page of the browser context, to check that views stay in sync. */
  openAnotherPage(): Promise<Page>;
}

export interface CanvasAgent<C extends AnyCanvas> {
  /** Run an action as the agent, including the built-in job actions. Defaults to the most recently opened instance. */
  invoke<K extends HarnessAction<C>>(action: K, input?: HarnessInput<C, K>, options?: { instanceId?: string }): Promise<HarnessResult<C, K>>;
  /** Messages the canvas sent to the agent with `ctx.sendToAgent()`, oldest first. */
  readonly messages: AgentMessage[];
  /** Make the next `ctx.sendToAgent()` fail, to test how the canvas reports it. */
  failNextSend(error?: Error): void;
  /**
   * Deliver a session event, such as `assistant.turn_start` or `session.idle`, to
   * drive `ctx.agent` and the page's `agent`. Its time defaults to the test clock.
   */
  sessionEvent(type: string, data?: Record<string, unknown>, at?: number): void;
}

export interface CanvasFixtures<C extends AnyCanvas> {
  /** The canvas running on a real local server with a temporary data folder. */
  canvasHarness: TestCanvas<C>;
  /** Open an instance, point `page` at it, and wait until it is live. */
  openCanvas(input?: unknown, options?: { instanceId?: string }): Promise<OpenedCanvas<C>>;
  /** Act as the agent and see what the canvas sent it. */
  agent: CanvasAgent<C>;
  /** Save state for a `persist` key before opening, to test reopening saved documents. */
  seed(key: string, state: unknown): Promise<void>;
  /**
   * Run a job now, as its schedule would. Defaults to the most recently opened
   * instance; pass `key` to run it for a saved document with no chat open.
   */
  runJob(id: JobName<C> | (string & {}), options?: RunJobOptions): Promise<JobOutcome>;
}

const DEFAULT_INSTANCE = 'test';

/**
 * Playwright fixtures for a canvas. Use the returned `test` like Playwright's own:
 *
 * ```ts
 * export const test = canvasTest(canvas)
 * test('adds a blocker', async ({ openCanvas, agent }) => { ... })
 * ```
 */
export function canvasTest<C extends AnyCanvas>(canvas: C, options: CanvasTestOptions = {}) {
  return base.extend<CanvasFixtures<C> & { _canvasState: { messages: AgentMessage[]; failures: Error[]; lastInstance: string } }>({
    _canvasState: async ({}, use) => {
      await use({ messages: [], failures: [], lastInstance: DEFAULT_INSTANCE });
    },

    canvasHarness: async ({ _canvasState }, use, testInfo) => {
      const name = options.name ?? canvasFolder(testInfo.file);
      const built = findBuiltPage(name, options.uiDir);
      const harness = await createTestCanvas(canvas, {
        uiDir: built.uiDir,
        indexFile: built.page,
        release: options.release ?? built.release,
        now: options.now,
        sendToAgent: async message => {
          const failure = _canvasState.failures.shift();
          if (failure) throw failure;
          _canvasState.messages.push(message);
          return `message-${_canvasState.messages.length}`;
        },
      });
      try {
        await use(harness);
      } finally {
        await harness.close();
      }
    },

    openCanvas: async ({ canvasHarness, page, _canvasState }, use) => {
      await use(async (input, { instanceId = DEFAULT_INSTANCE } = {}) => {
        const { url } = await canvasHarness.open(instanceId, input);
        _canvasState.lastInstance = instanceId;
        await gotoLive(page, url);
        return {
          page,
          url,
          instanceId,
          state: () => canvasHarness.state(instanceId),
          openAnotherPage: async () => {
            const another = await page.context().newPage();
            await gotoLive(another, url);
            return another;
          },
        };
      });
    },

    agent: async ({ canvasHarness, _canvasState }, use) => {
      await use({
        invoke: (action, input, { instanceId } = {}) =>
          canvasHarness.invoke(instanceId ?? _canvasState.lastInstance, action, input, 'agent') as never,
        messages: _canvasState.messages,
        failNextSend: (error = new Error('The agent could not be reached')) => {
          _canvasState.failures.push(error);
        },
        sessionEvent: (type, data, at) => canvasHarness.sessionEvent(type, data, at),
      });
    },

    seed: async ({ canvasHarness }, use) => {
      await use(async (key, state) => {
        if (!canvas.persist) throw new Error(`${canvas.id} does not set persist, so there is nothing to seed`);
        const store = new StateStore(canvasDataDir(canvas.id, canvasHarness.dataRoot), canvas.state, canvas.persist.version);
        await store.save(key, canvas.state.parse(state));
      });
    },

    runJob: async ({ canvasHarness, _canvasState }, use) => {
      await use((job, runOptions = {}) =>
        canvasHarness.runJob(job, runOptions.key === undefined && runOptions.instanceId === undefined ? { ...runOptions, instanceId: _canvasState.lastInstance } : runOptions),
      );
    },
  });
}

/** The canvas folder a spec belongs to: the nearest folder at or above it with a `canvas.ts`. */
function canvasFolder(file: string): string {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'canvas.ts'))) return basename(dir);
  }
  throw new Error(`${file} is not in a canvas folder (one with a canvas.ts); pass name to canvasTest().`);
}

/** The built page for a canvas, and the unpublished release of the plugin it is in. */
function findBuiltPage(name: string, uiDir?: string): { uiDir: string; page: string; release: ReleaseInfo } {
  const page = `${name}.html`;
  const candidates: { uiDir: string; plugin: string }[] = [];
  if (uiDir) {
    candidates.push({ uiDir: resolve(uiDir), plugin: resolve(uiDir, '..', '..', '..') });
  } else {
    const plugins = resolve('dist', 'plugins');
    for (const plugin of existsSync(plugins) ? readdirSync(plugins) : []) {
      const extensions = join(plugins, plugin, 'extensions');
      for (const extension of existsSync(extensions) ? readdirSync(extensions) : []) {
        candidates.push({ uiDir: join(extensions, extension, 'ui'), plugin: join(plugins, plugin) });
      }
    }
  }
  const found = candidates.find(candidate => existsSync(join(candidate.uiDir, page)));
  if (!found) {
    throw new Error(`No built page for ${name} (${page}) in ${uiDir ? resolve(uiDir) : resolve('dist', 'plugins')}. Build the project first (for example \`pnpm build\`).`);
  }
  return { uiDir: found.uiDir, page, release: localRelease(found.plugin) };
}

/** The footer of an unpublished build of a built plugin. */
function localRelease(pluginDir: string): ReleaseInfo {
  try {
    const { name, version } = JSON.parse(readFileSync(join(pluginDir, '.plugin', 'plugin.json'), 'utf8')) as { name?: string; version?: string };
    return { name: name ?? basename(pluginDir), version: version ?? '0.0.0', channel: 'local' };
  } catch {
    return { name: basename(pluginDir), version: '0.0.0', channel: 'local' };
  }
}

/**
 * Playwright config for canvas tests: `*.spec.ts` files under `canvases/`, run in
 * light, dark, and high-contrast Chromium. Pass overrides as you would to `defineConfig`.
 */
export function defineCanvasConfig(config: PlaywrightTestConfig = {}): PlaywrightTestConfig {
  const chrome = devices['Desktop Chrome'];
  return defineConfig({
    testDir: 'canvases',
    testMatch: '**/*.spec.ts',
    fullyParallel: true,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['github'], ['list']] : 'list',
    use: { trace: 'retain-on-failure' },
    projects: [
      { name: 'light', use: { ...chrome, colorScheme: 'light' } },
      { name: 'dark', use: { ...chrome, colorScheme: 'dark' } },
      { name: 'high-contrast', use: { ...chrome, colorScheme: 'dark', contextOptions: { forcedColors: 'active' } } },
    ],
    ...config,
  });
}

async function gotoLive(page: Page, url: string) {
  await page.goto(url);
  await page.locator('html[data-canvas-status="live"]').waitFor({ state: 'attached' });
}

export { expect } from '@playwright/test';
