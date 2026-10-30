import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineCanvas, z } from '../src/index.ts';
import { runCanvasJob } from '../src/server/headless.ts';
import { StateStore } from '../src/server/storage.ts';
import { createTestCanvas, type TestCanvas } from '../src/testing.ts';

const roots: string[] = [];
const harnesses: TestCanvas<typeof board>[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function dataRoot() {
  const root = await mkdtemp(join(tmpdir(), 'canvas-kit-coord-'));
  roots.push(root);
  return root;
}

const runs: string[] = [];
const board = defineCanvas({
  id: 'kit-coord-board',
  title: 'Board',
  description: 'Items shared across chats.',
  input: z.object({ repo: z.string() }),
  state: z.object({ items: z.array(z.string()), ticks: z.number() }),
  init: () => ({ items: [], ticks: 0 }),
  persist: { key: ({ input }) => input.repo },
  actions: ({ action }) => ({
    add: action({
      description: 'Add an item.',
      input: z.object({ text: z.string() }),
      run: async (ctx, { text }) => {
        // Yield inside the action so concurrent chats really interleave.
        await new Promise(done => setTimeout(done, 1));
        ctx.setState(s => ({ ...s, items: [...s.items, text] }));
      },
    }),
  }),
  jobs: ({ job }) => ({
    tick: job({
      every: '1m',
      run: async ctx => {
        runs.push(`${ctx.key}:${ctx.headless ? 'headless' : 'chat'}:${ctx.lastRunAt ?? 'first'}`);
        ctx.setState(s => ({ ...s, ticks: s.ticks + 1 }));
      },
    }),
    nudge: job({
      every: '1h',
      run: async ctx => {
        ctx.setState(s => ({ ...s, ticks: s.ticks + 100 }));
        await ctx.sendToAgent({ prompt: `Board ${ctx.key} has ${ctx.state.items.length} items` });
      },
    }),
  }),
});

/** A chat: its own host, like a separate extension process, on a shared data folder. */
async function chat(root: string, options: Parameters<typeof createTestCanvas>[1] = {}) {
  const harness = await createTestCanvas(board, { dataRoot: root, ...options });
  harnesses.push(harness);
  return harness;
}

describe('documents shared across chats', () => {
  it('never loses an update and shows each chat the others\' changes live', async () => {
    const root = await dataRoot();
    const a = await chat(root);
    const b = await chat(root);
    await a.open('a', { repo: 'octo/app' });
    await b.open('b', { repo: 'octo/app' });

    await a.invoke('a', 'add', { text: 'from A' });
    await b.invoke('b', 'add', { text: 'from B' });
    expect(b.state('b')?.items).toEqual(['from A', 'from B']);
    // A's page catches up without any action of its own.
    await vi.waitFor(() => expect(a.state('a')?.items).toEqual(['from A', 'from B']), { timeout: 5_000 });

    // Many concurrent changes from both chats all land.
    const texts = Array.from({ length: 20 }, (_, index) => `item ${index}`);
    await Promise.all(texts.map((text, index) => (index % 2 ? a.invoke('a', 'add', { text }) : b.invoke('b', 'add', { text }))));
    const saved = await new StateStore(join(root, 'kit-coord-board'), board.state, 1).read('octo/app');
    const items = (saved?.state as { items: string[] } | undefined)?.items;
    expect(items).toHaveLength(22);
    expect(new Set(items)).toEqual(new Set(['from A', 'from B', ...texts]));
    // Created once on first open, then one revision per change.
    expect(saved?.revision).toBe(23);
  });

  it('picks up other chats\' changes when an instance is reopened', async () => {
    const root = await dataRoot();
    const a = await chat(root);
    const b = await chat(root);
    await a.open('a', { repo: 'octo/app' });
    await b.open('b', { repo: 'octo/app' });
    await b.invoke('b', 'add', { text: 'from B' });
    await a.open('a', { repo: 'octo/app' });
    expect(a.state('a')?.items).toEqual(['from B']);
  });
});

describe('the cross-process lock', () => {
  const store = (root: string, options = {}) => new StateStore(join(root, 'kit-coord-board'), board.state, 1, options);
  const lockFile = (root: string) => `${store(root).fileFor('octo/app')}.lock`;

  it('waits for a live holder and reports busy when it does not let go', async () => {
    const root = await dataRoot();
    await mkdir(join(root, 'kit-coord-board', 'state'), { recursive: true });
    // A fresh lock held by a running process (this one, standing in for another chat).
    await writeFile(lockFile(root), JSON.stringify({ pid: process.pid, nonce: 'other' }));
    await expect(store(root, { lockWaitMs: 100 }).lock('octo/app', async () => 'never')).rejects.toMatchObject({ code: 'busy' });
    // Its holder stops refreshing it: it is taken over.
    const old = new Date(Date.now() - 60_000);
    await utimes(lockFile(root), old, old);
    expect(await store(root, { lockWaitMs: 2_000, lockStaleMs: 10_000 }).lock('octo/app', async () => 'ran')).toBe('ran');
  });

  it('takes over at once from a holder that exited, and removes only its own lock', async () => {
    const root = await dataRoot();
    await mkdir(join(root, 'kit-coord-board', 'state'), { recursive: true });
    const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    await writeFile(lockFile(root), JSON.stringify({ pid: Number(exited.stdout), nonce: 'gone' }));
    const started = Date.now();
    expect(await store(root, { lockWaitMs: 5_000, lockStaleMs: 60_000 }).lock('octo/app', async () => 'ran')).toBe('ran');
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(readFile(lockFile(root))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('takes over an empty lock left by a holder that crashed while writing it, once it is stale', async () => {
    const root = await dataRoot();
    await mkdir(join(root, 'kit-coord-board', 'state'), { recursive: true });
    await writeFile(lockFile(root), '');
    // Fresh: it may be a holder that has not written it yet.
    await expect(store(root, { lockWaitMs: 100 }).lock('octo/app', async () => 'never')).rejects.toMatchObject({ code: 'busy' });
    const old = new Date(Date.now() - 60_000);
    await utimes(lockFile(root), old, old);
    expect(await store(root, { lockWaitMs: 2_000, lockStaleMs: 10_000 }).lock('octo/app', async () => 'ran')).toBe('ran');
  });
});

describe('scheduled jobs', () => {
  it('validate their schedule', () => {
    const make = (every: unknown) =>
      defineCanvas({
        id: 'kit-bad-jobs',
        title: 'Bad',
        description: 'Bad jobs.',
        state: z.object({}),
        init: () => ({}),
        jobs: ({ job }) => ({ check: job({ every: every as '1m', run: () => {} }) }),
      });
    expect(() => make('soon')).toThrow(/at least 1 second/);
    expect(() => make(500)).toThrow(/at least 1 second/);
    expect(make('1.5h').jobs.get('check')?.everyMs).toBe(5_400_000);
  });

  it('run once per interval across chats, and catch up when overdue', async () => {
    runs.length = 0;
    const root = await dataRoot();
    let now = Date.parse('2026-10-29T12:00:00Z');
    const a = await chat(root, { now: () => now });
    const b = await chat(root, { now: () => now });
    await a.open('a', { repo: 'octo/app' });
    await b.open('b', { repo: 'octo/app' });

    await a.tickJobs();
    await b.tickJobs();
    expect(runs).toEqual(['octo/app:chat:first']);
    expect(b.state('b')?.ticks).toBe(101);

    now += 30_000;
    await a.tickJobs();
    await b.tickJobs();
    expect(runs).toHaveLength(1);

    now += 30_000;
    await b.tickJobs();
    await a.tickJobs();
    expect(runs).toEqual(['octo/app:chat:first', 'octo/app:chat:2026-10-29T12:00:00.000Z']);
    await vi.waitFor(() => expect(a.state('a')?.ticks).toBe(102));
    expect(a.sentToAgent.length + b.sentToAgent.length).toBe(1);
  });

  it('record failures, roll back their changes, and run headless for saved documents', async () => {
    runs.length = 0;
    const root = await dataRoot();
    const sending = await chat(root, { sendToAgent: async () => Promise.reject(new Error('session ended')) });
    await sending.open('a', { repo: 'octo/app' });
    expect(await sending.runJob('nudge')).toMatchObject({ job: 'nudge', key: 'octo/app', ran: true, error: expect.stringContaining('session ended') });
    expect(sending.state('a')?.ticks).toBe(0);
    await sending.close();

    // No chat has the document open: run it from its saved state, as `canvas-kit run` does.
    const headless = await chat(root, { sendToAgent: undefined });
    expect(await headless.runJob('tick', { key: 'octo/app', headless: true, force: false })).toMatchObject({ ran: true });
    expect(await headless.runJob('tick', { key: 'octo/app', headless: true, force: false })).toMatchObject({ ran: false });
    expect(runs).toEqual(['octo/app:headless:first']);
    const saved = JSON.parse(await readFile(store(root).fileFor('octo/app'), 'utf8')) as {
      state: { ticks: number };
      jobs: Record<string, { lastRunAt: string; lastError?: string }>;
    };
    expect(saved.state.ticks).toBe(1);
    expect(saved.jobs.nudge?.lastError).toContain('session ended');
    await expect(headless.runJob('tick', { key: 'octo/other' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(headless.runJob('missing' as 'tick')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('run for every saved document with no chat open, as `canvas-kit run` does', async () => {
    runs.length = 0;
    const root = await dataRoot();
    const a = await chat(root);
    await a.open('a', { repo: 'octo/one' });
    await a.open('b', { repo: 'octo/two' });
    await a.close();

    expect(await runCanvasJob(board, 'tick', { dataRoot: root })).toEqual([
      expect.objectContaining({ ran: true }),
      expect.objectContaining({ ran: true }),
    ]);
    expect(runs.sort()).toEqual(['octo/one:headless:first', 'octo/two:headless:first']);
    expect(await runCanvasJob(board, 'tick', { dataRoot: root, key: 'octo/one' })).toEqual([expect.objectContaining({ key: 'octo/one', ran: false })]);
    // With no agent, sendToAgent fails, so jobs that need the agent check ctx.headless.
    const [nudge] = await runCanvasJob(board, 'nudge', { dataRoot: root, key: 'octo/one' });
    expect(nudge).toMatchObject({ ran: true, error: expect.stringMatching(/agent/i) });
    await expect(runCanvasJob(board, 'missing', { dataRoot: root })).rejects.toThrow('Board has no job missing. Its jobs: tick, nudge.');
  });

  it('undo a run whose save failed, and retry it at the next tick', async () => {
    runs.length = 0;
    const root = await dataRoot();
    const a = await chat(root);
    await a.open('a', { repo: 'octo/full' });
    const write = vi.spyOn(StateStore.prototype, 'write').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(a.runJob('tick')).rejects.toThrow('disk full');
    } finally {
      write.mockRestore();
    }
    expect(a.state('a')?.ticks).toBe(0);
    await a.tickJobs();
    expect(a.state('a')?.ticks).toBe(101);
    expect(runs).toEqual(['octo/full:chat:first', 'octo/full:chat:first']);
  });

  it('start on open and run on a timer in auto mode', async () => {
    runs.length = 0;
    const root = await dataRoot();
    const a = await chat(root, { jobs: 'auto' });
    await a.open('a', { repo: 'octo/auto' });
    await vi.waitFor(() => expect(a.state('a')?.ticks).toBe(101), { timeout: 2_000 });
    expect(runs).toEqual(['octo/auto:chat:first']);
  });

  function store(root: string) {
    return new StateStore(join(root, 'kit-coord-board'), board.state, 1);
  }
});
