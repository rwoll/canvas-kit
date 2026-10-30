import { defineConfig, devices, test as base, type Page, type PlaywrightTestConfig } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { AgentMessage, AnyCanvas, JobName, StateOf } from './define.ts';
import type { JobOutcome, RunJobOptions } from './server/host.ts';
import type { ReleaseInfo } from './server/release.ts';
import { StateStore, canvasDataDir } from './server/storage.ts';
import { createTestCanvas, type HarnessAction, type HarnessInput, type HarnessResult, type TestCanvas } from './testing.ts';

export interface CanvasTestOptions {
  /**
   * Folder with the built UI. Defaults to `dist/plugin/extensions/<name>/ui` in the
   * current folder, where `<name>` is the current folder's name, which is what
   * `vite build` writes for a canvas package.
   */
  uiDir?: string;
  /**
   * Release shown in the version footer. Defaults to an unpublished build of the
   * package in the current folder, so screenshots stay stable.
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
  const uiDir = resolve(options.uiDir ?? join('dist', 'plugin', 'extensions', basename(process.cwd()), 'ui'));
  const assertBuilt = () => {
    if (!existsSync(join(uiDir, 'index.html'))) {
      throw new Error(`No built canvas UI in ${uiDir}. Build the canvas first (for example \`pnpm build\`), or pass uiDir to canvasTest().`);
    }
  };
  const release = options.release ?? localRelease();

  return base.extend<CanvasFixtures<C> & { _canvasState: { messages: AgentMessage[]; failures: Error[]; lastInstance: string } }>({
    _canvasState: async ({}, use) => {
      await use({ messages: [], failures: [], lastInstance: DEFAULT_INSTANCE });
    },

    canvasHarness: async ({ _canvasState }, use) => {
      assertBuilt();
      const harness = await createTestCanvas(canvas, {
        uiDir,
        release,
        now: options.now,
        sendToAgent: async message => {
          const failure = _canvasState.failures.shift();
          if (failure) throw failure;
          _canvasState.messages.push(message);
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

/** The footer of an unpublished build of the canvas package in the current folder. */
function localRelease(): ReleaseInfo {
  const name = basename(process.cwd());
  try {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string };
    return { name, version: version ?? '0.0.0', channel: 'local' };
  } catch {
    return { name, version: '0.0.0', channel: 'local' };
  }
}

/**
 * Playwright config for canvas tests: specs in `e2e/`, run in light, dark, and
 * high-contrast Chromium. Pass overrides as you would to `defineConfig`.
 */
export function defineCanvasConfig(config: PlaywrightTestConfig = {}): PlaywrightTestConfig {
  const chrome = devices['Desktop Chrome'];
  return defineConfig({
    testDir: 'e2e',
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
