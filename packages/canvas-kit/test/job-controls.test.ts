import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { CanvasClient } from '../src/client.ts';
import { defineCanvas, formatInterval, intervalMs, z, type JobStatusOf, type JobWithInputName } from '../src/index.ts';
import { runCanvasJob } from '../src/server/headless.ts';
import { StateStore } from '../src/server/storage.ts';
import { createTestCanvas, type TestCanvas } from '../src/testing.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const HOUR = 3_600_000;
let now = Date.parse('2026-10-01T09:00:00Z');

const board = defineCanvas({
  id: 'kit-job-controls',
  title: 'Board',
  description: 'Notes that jobs add to.',
  input: z.object({ repo: z.string() }),
  state: z.object({ notes: z.array(z.string()) }),
  init: () => ({ notes: [] }),
  persist: { key: ({ input }) => input.repo },
  jobs: ({ job }) => ({
    tidy: job({
      every: '1h',
      minEvery: '15m',
      maxEvery: '1d',
      controls: 'both',
      description: 'Tidy the notes.',
      run: ctx => {
        ctx.setState(s => ({ notes: [...s.notes, `tidy ${ctx.headless ? 'headless' : 'chat'}`] }));
      },
    }),
    remind: job({
      every: '1d',
      minEvery: '1h',
      controls: 'ui',
      description: 'Add a note on a schedule.',
      input: z.object({ text: z.string().min(1).max(100) }),
      maxJobs: 2,
      run: (ctx, { text }) => {
        ctx.setState(s => ({ notes: [...s.notes, text] }));
      },
    }),
    internal: job({ every: '1h', run: () => {} }),
  }),
});

async function chat(dataRoot?: string) {
  const harness = await createTestCanvas(board, { now: () => now, dataRoot });
  cleanups.push(() => harness.close());
  await harness.open('a', { repo: 'octo/app' });
  return harness;
}

async function sharedRoot() {
  const root = await mkdtemp(join(tmpdir(), 'canvas-kit-jobs-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

const add = (harness: TestCanvas<typeof board>, text: string, extra: Record<string, unknown> = {}) =>
  harness.invoke('a', 'add_job', { job: 'remind', input: { text }, ...extra }, 'ui') as Promise<JobStatusOf<typeof board>>;

describe('job controls', () => {
  it('check their definitions and add built-in actions for the jobs that allow them', () => {
    const base = { id: 'x', title: 'X', description: 'X.', state: z.object({}), init: () => ({}) };
    expect(() => defineCanvas({ ...base, jobs: ({ job }) => ({ a: job({ every: '1h', input: z.object({}), run: () => {} }) }) })).toThrow(
      /has input, so it needs controls/,
    );
    expect(() => defineCanvas({ ...base, jobs: ({ job }) => ({ a: job({ every: '1h', minEvery: '2h', controls: 'ui', run: () => {} }) }) })).toThrow(
      /minEvery <= every <= maxEvery/,
    );
    expect(() =>
      defineCanvas({
        ...base,
        actions: ({ action }) => ({ run_job: action({ description: 'Mine.', run: () => {} }) }),
        jobs: ({ job }) => ({ a: job({ every: '1h', controls: 'ui', run: () => {} }) }),
      }),
    ).toThrow(/run_job is reserved/);
    // Without controls, no built-in actions.
    const quiet = defineCanvas({ ...base, jobs: ({ job }) => ({ a: job({ every: '1h', run: () => {} }) }) });
    expect([...quiet.actions.keys()]).toEqual(['get_state']);

    const exposure = Object.fromEntries([...board.actions.values()].map(action => [action.name, action.expose]));
    expect(exposure).toEqual({ get_state: 'agent', list_jobs: 'both', update_job: 'both', run_job: 'both', add_job: 'ui', remove_job: 'ui' });
    expect(JSON.stringify(board.actions.get('add_job')?.inputJsonSchema)).toContain('"text"');
    expectTypeOf<JobWithInputName<typeof board>>().toEqualTypeOf<'remind'>();
    expect([formatInterval(intervalMs('90m')), formatInterval(HOUR), formatInterval(1_500)]).toEqual(['90m', '1h', 1_500]);
  });

  it('let the UI pause, resume, retime, and run a declared job', async () => {
    now = Date.parse('2026-10-01T09:00:00Z');
    const harness = await chat();
    expect(harness.jobs('a')).toEqual([
      { id: 'tidy', job: 'tidy', description: 'Tidy the notes.', every: HOUR, minEvery: 15 * 60_000, maxEvery: 24 * HOUR, enabled: true, controls: 'both', added: false },
      { id: 'internal', job: 'internal', every: HOUR, minEvery: HOUR, maxEvery: 30 * 24 * HOUR, enabled: true, added: false },
    ]);
    await harness.tickJobs();
    expect(harness.state('a')?.notes).toEqual(['tidy chat']);
    expect(harness.jobs('a')?.[0]).toMatchObject({ lastRunAt: '2026-10-01T09:00:00.000Z', nextRunAt: '2026-10-01T10:00:00.000Z' });

    expect(await harness.invoke('a', 'update_job', { id: 'tidy', enabled: false }, 'ui')).toMatchObject({ enabled: false });
    expect(harness.jobs('a')?.[0]).not.toHaveProperty('nextRunAt');
    now += 3 * HOUR;
    await harness.tickJobs();
    expect(harness.state('a')?.notes).toHaveLength(1);
    // Run now works while paused.
    expect(await harness.invoke('a', 'run_job', { id: 'tidy' }, 'ui')).toMatchObject({ lastRunAt: '2026-10-01T12:00:00.000Z' });
    expect(harness.state('a')?.notes).toHaveLength(2);

    await expect(harness.invoke('a', 'update_job', { id: 'tidy', every: '5m' }, 'ui')).rejects.toThrow('tidy runs every 15m to 1d');
    await harness.invoke('a', 'update_job', { id: 'tidy', every: '15m', enabled: true }, 'ui');
    now += 15 * 60_000;
    await harness.tickJobs();
    expect(harness.state('a')?.notes).toHaveLength(3);
    // Jobs without controls stay out of reach.
    await expect(harness.invoke('a', 'update_job', { id: 'internal', enabled: false }, 'ui')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('let the UI add, list, and remove jobs from a job with input, within limits', async () => {
    now = Date.parse('2026-10-01T09:00:00Z');
    const harness = await chat();
    const added = await add(harness, 'Check security sign-off', { every: '2h' });
    expect(added).toMatchObject({ job: 'remind', input: { text: 'Check security sign-off' }, every: 2 * HOUR, added: true, enabled: true });
    expect(added.id).toMatch(/^remind-[0-9a-f]{6}$/);
    await harness.tickJobs();
    expect(harness.state('a')?.notes).toContain('Check security sign-off');

    await expect(add(harness, '')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(add(harness, 'Every minute', { every: '1m' })).rejects.toThrow('remind runs every 1h to 30d');
    const second = await add(harness, 'Paused', { enabled: false });
    await expect(add(harness, 'Third')).rejects.toMatchObject({ code: 'limit_reached' });
    expect(harness.jobs('a')?.map(job => job.id)).toEqual(['tidy', 'internal', added.id, second.id]);

    await harness.tickJobs();
    expect(harness.state('a')?.notes).not.toContain('Paused');
    await harness.invoke('a', 'remove_job', { id: second.id }, 'ui');
    expect(harness.jobs('a')?.map(job => job.id)).toEqual(['tidy', 'internal', added.id]);
    await expect(harness.invoke('a', 'remove_job', { id: 'tidy' }, 'ui')).rejects.toThrow('tidy is declared by the canvas; pause it instead');
    await expect(harness.runJob('remind')).rejects.toThrow(/takes input/);
  });

  it('give the agent only the jobs it may control', async () => {
    const harness = await chat();
    const added = await add(harness, 'From the UI');
    const listed = (await harness.invoke('a', 'list_jobs', {})) as { id: string }[];
    expect(listed.map(job => job.id)).toEqual(['tidy']);
    await harness.invoke('a', 'update_job', { id: 'tidy', every: '6h' });
    await expect(harness.invoke('a', 'update_job', { id: added.id, enabled: false })).rejects.toMatchObject({ code: 'not_found' });
    await expect(harness.invoke('a', 'run_job', { id: added.id })).rejects.toMatchObject({ code: 'not_found' });
    // add_job and remove_job are the UI's only.
    await expect(harness.invoke('a', 'add_job', { job: 'remind', input: { text: 'x' } })).rejects.toThrow('Unknown action: add_job');
  });

  it('share settings and added jobs across chats, and with canvas-kit run', async () => {
    now = Date.parse('2026-10-01T09:00:00Z');
    const root = await sharedRoot();
    const a = await chat(root);
    const b = await chat(root);
    const added = await add(a, 'Shared');
    await a.invoke('a', 'update_job', { id: 'tidy', enabled: false }, 'ui');
    await vi.waitFor(() => expect(b.jobs('a')?.map(job => [job.id, job.enabled])).toEqual([['tidy', false], ['internal', true], [added.id, true]]), {
      timeout: 5_000,
    });

    // The added job runs once across both chats.
    await Promise.all([a.tickJobs(), b.tickJobs()]);
    const store = new StateStore(join(root, 'kit-job-controls'), board.state, 1);
    expect((await store.read('octo/app'))?.state).toEqual({ notes: ['Shared'] });
    await Promise.all([a.close(), b.close()]);

    // With no chat open: every due job, then one job by name or ID.
    now += 25 * HOUR;
    const outcomes = await runCanvasJob(board, undefined, { dataRoot: root });
    expect(outcomes.map(outcome => [outcome.id, outcome.ran, outcome.paused])).toEqual([
      ['tidy', false, true],
      ['internal', true, undefined],
      [added.id, true, undefined],
    ]);
    expect(await runCanvasJob(board, 'tidy', { dataRoot: root })).toMatchObject([{ id: 'tidy', ran: false, paused: true }]);
    expect(await runCanvasJob(board, 'tidy', { dataRoot: root, force: true })).toMatchObject([{ id: 'tidy', ran: true }]);
    expect(await runCanvasJob(board, added.id, { dataRoot: root, force: true })).toMatchObject([{ id: added.id, ran: true }]);
    expect((await store.read('octo/app'))?.state).toEqual({ notes: ['Shared', 'Shared', 'tidy headless', 'Shared'] });
    await expect(runCanvasJob(board, 'nope-abc123', { dataRoot: root })).rejects.toThrow('Board has no job nope-abc123');
  });

  it('drop user settings when a later version removes a job\'s controls', async () => {
    now = Date.parse('2026-10-01T09:00:00Z');
    const root = await sharedRoot();
    const before = await chat(root);
    await before.invoke('a', 'update_job', { id: 'tidy', enabled: false, every: '1d' }, 'ui');
    await before.close();

    const later = defineCanvas({
      ...{ id: board.id, title: 'Board', description: 'Notes that jobs add to.', input: z.object({ repo: z.string() }) },
      state: z.object({ notes: z.array(z.string()) }),
      init: () => ({ notes: [] }),
      persist: { key: ({ input }) => input.repo },
      jobs: ({ job }) => ({ tidy: job({ every: '1h', run: ctx => void ctx.setState(s => ({ notes: [...s.notes, 'tidy'] })) }) }),
    });
    const harness = await createTestCanvas(later, { now: () => now, dataRoot: root });
    cleanups.push(() => harness.close());
    await harness.open('a', { repo: 'octo/app' });
    expect(harness.jobs('a')).toMatchObject([{ id: 'tidy', enabled: true, every: HOUR }]);
    await harness.tickJobs();
    expect(harness.state('a')?.notes).toEqual(['tidy']);
  });

  it('record an error when an added job\'s saved input no longer validates', async () => {
    const root = await sharedRoot();
    const store = new StateStore(join(root, 'kit-job-controls'), board.state, 1);
    await store.lock('octo/app', () =>
      store.write('octo/app', { state: { notes: [] }, revision: 1, jobs: { 'remind-abcdef': { job: 'remind', input: { text: '' }, createdAt: '2026-01-01T00:00:00Z' } } }),
    );
    const harness = await chat(root);
    expect(await harness.runJob('remind-abcdef')).toMatchObject({ ran: true, error: expect.stringContaining('remind-abcdef has input that remind no longer accepts') });
    expect(harness.jobs('a')?.[2]).toMatchObject({ id: 'remind-abcdef', lastError: expect.stringContaining('no longer accepts') });
    await expect(harness.invoke('a', 'run_job', { id: 'remind-abcdef' }, 'ui')).rejects.toMatchObject({ code: 'job_failed' });
  });

  it('reach the browser client live, with typed calls', async () => {
    const harness = await chat();
    const { url } = await harness.open('a', { repo: 'octo/app' });
    const html = await (await fetch(url)).text();
    const bootstrap = JSON.parse(/id="canvas-kit-bootstrap">(.*?)<\/script>/s.exec(html)![1]!);
    const origin = new URL(url).origin;
    const client = new CanvasClient<typeof board>(bootstrap, {
      fetch: (input, init) => fetch(new URL(String(input), url), { ...init, headers: { ...init?.headers, Origin: origin } }),
    });
    cleanups.push(async () => client.close());
    expect(client.jobDefinitions.map(job => [job.name, job.hasInput, job.controls])).toEqual([
      ['tidy', false, 'both'],
      ['remind', true, 'ui'],
      ['internal', false, undefined],
    ]);
    client.subscribe(() => {});
    const added = await client.addJob('remind', { text: 'From the page' }, { every: '3h' });
    expectTypeOf(added.job).toEqualTypeOf<'tidy' | 'remind' | 'internal'>();
    await vi.waitFor(() => expect(client.getSnapshot().jobs.map(job => job.id)).toContain(added.id));
    await client.updateJob('tidy', { enabled: false });
    await vi.waitFor(() => expect(client.getSnapshot().jobs[0]?.enabled).toBe(false));
    await client.removeJob(added.id);
    await vi.waitFor(() => expect(client.getSnapshot().jobs.map(job => job.id)).toEqual(['tidy', 'internal']));
  });
});
