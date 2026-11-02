import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineCanvas, z, type AgentActivity } from '../src/index.ts';
import { AgentActivityTracker, type CanvasSession, type SessionEventLike } from '../src/server/activity.ts';
import { CanvasHost } from '../src/server/host.ts';
import { createTestCanvas } from '../src/testing.ts';

const T0 = Date.parse('2026-10-01T09:00:00Z');
const at = (ms: number) => new Date(ms).toISOString();

interface Seen {
  sessionId: string | undefined;
  agent: AgentActivity;
  manual?: boolean;
  every?: number;
  instanceIds?: readonly string[];
}

const watcher = defineCanvas({
  id: 'kit-agent-watcher',
  title: 'Watcher',
  description: 'Records what it sees of the session.',
  state: z.object({ openedBy: z.string(), seen: z.array(z.custom<Seen>()) }),
  init: ({ sessionId }) => ({ openedBy: sessionId ?? 'none', seen: [] }),
  persist: { key: ({ sessionId }) => sessionId ?? 'local' },
  actions: ({ action }) => ({
    look: action({
      description: 'Record what the agent is doing.',
      run: ctx => ctx.setState(state => ({ ...state, seen: [...state.seen, { sessionId: ctx.sessionId, agent: ctx.agent }] })),
    }),
    nudge: action({
      description: 'Message the agent.',
      expose: 'ui',
      run: ctx => ctx.sendToAgent({ prompt: 'Please update the watcher canvas now.', displayPrompt: 'Watcher' }),
    }),
  }),
  jobs: ({ job }) => ({
    check: job({
      every: '10m',
      controls: 'both',
      minEvery: '1m',
      run: ctx => {
        ctx.setState(state => ({
          ...state,
          seen: [...state.seen, { sessionId: ctx.sessionId, agent: ctx.agent, manual: ctx.manual, every: ctx.every, instanceIds: ctx.instanceIds }],
        }));
      },
    }),
  }),
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('agent activity', () => {
  it('is busy from a turn until the session is idle', () => {
    const tracker = new AgentActivityTracker(() => T0);
    let changes = 0;
    tracker.onChange(() => (changes += 1));
    expect(tracker.activity).toEqual({ busy: false });
    tracker.ingest({ type: 'assistant.turn_start', timestamp: at(T0) });
    tracker.ingest({ type: 'assistant.message', timestamp: at(T0 + 1) });
    expect(tracker.activity).toEqual({ busy: true });
    tracker.ingest({ type: 'session.idle', timestamp: at(T0 + 2) });
    expect(tracker.activity).toEqual({ busy: false, idleSince: T0 + 2 });
    expect(changes).toBe(2);
  });

  it('is idle after a history whose last turn ended, since session.idle is never saved', () => {
    const tracker = new AgentActivityTracker(() => T0);
    tracker.ingest({ type: 'user.message', timestamp: at(T0), data: { content: 'Go' } });
    tracker.ingest({ type: 'assistant.turn_start', timestamp: at(T0 + 1) });
    tracker.ingest({ type: 'assistant.turn_end', timestamp: at(T0 + 2) });
    expect(tracker.activity.busy).toBe(true);
    tracker.historyEnded();
    expect(tracker.activity).toEqual({ busy: false, lastActivityAt: T0, idleSince: T0 + 2 });

    // A history that stops mid-turn means the agent is still working.
    const working = new AgentActivityTracker(() => T0);
    working.ingest({ type: 'assistant.turn_end', timestamp: at(T0) });
    working.ingest({ type: 'assistant.turn_start', timestamp: at(T0 + 1) });
    working.historyEnded();
    expect(working.activity.busy).toBe(true);
  });

  it('counts the agent\'s own work, not canvas tools or messages the canvas sent', () => {
    const tracker = new AgentActivityTracker(() => T0);
    tracker.ingest({ type: 'tool.execution_start', timestamp: at(T0), data: { toolCallId: 'a', toolName: 'invoke_canvas_action' } });
    tracker.ingest({ type: 'tool.execution_complete', timestamp: at(T0 + 1), data: { toolCallId: 'a' } });
    tracker.ingest({ type: 'tool.execution_start', timestamp: at(T0 + 2), data: { toolCallId: 'b', toolName: 'report_intent' } });
    expect(tracker.activity.lastActivityAt).toBeUndefined();

    tracker.sent('m1');
    tracker.ingest({ type: 'user.message', timestamp: at(T0 + 3), data: { messageId: 'm1', content: 'Refresh' } });
    // A message can arrive before send() resolves with its ID; its prompt still identifies it.
    tracker.sending('Please refresh the canvas.');
    tracker.ingest({ type: 'user.message', timestamp: at(T0 + 4), data: { content: 'Refresh', transformedContent: '<x>Please refresh the canvas.</x>' } });
    tracker.ingest({ type: 'assistant.turn_start', timestamp: at(T0 + 5) });
    expect(tracker.activity.lastActivityAt).toBeUndefined();

    tracker.ingest({ type: 'tool.execution_start', timestamp: at(T0 + 6), data: { toolCallId: 'c', toolName: 'bash' } });
    expect(tracker.activity.lastActivityAt).toBe(T0 + 6);
    tracker.ingest({ type: 'tool.execution_complete', timestamp: at(T0 + 7), data: { toolCallId: 'c' } });
    tracker.ingest({ type: 'user.message', timestamp: at(T0 + 8), data: { messageId: 'm2', content: 'Fix the bug' } });
    tracker.ingest({ type: 'permission.requested', timestamp: at(T0 + 9), data: {} });
    expect(tracker.activity.lastActivityAt).toBe(T0 + 9);
    // Events out of order never move the clock back.
    tracker.ingest({ type: 'session.error', timestamp: at(T0), data: {} });
    expect(tracker.activity.lastActivityAt).toBe(T0 + 9);
  });

  it('gives actions and jobs the session, the agent, and how the job was run', async () => {
    let now = T0;
    const harness = await createTestCanvas(watcher, { now: () => now, sessionId: 'chat-1' });
    cleanups.push(() => harness.close());
    await harness.open('a');
    await harness.open('b');
    expect(harness.state('a')?.openedBy).toBe('chat-1');

    harness.sessionEvent('assistant.turn_start');
    now += 1_000;
    harness.sessionEvent('tool.execution_start', { toolCallId: 't', toolName: 'edit' });
    await harness.invoke('a', 'look');
    await harness.runJob('check', { instanceId: 'a' });
    now += 1_000;
    harness.sessionEvent('session.idle');
    await harness.invoke('a', 'update_job', { id: 'check', every: '2m' });
    now += 2 * 60_000;
    await harness.tickJobs();

    expect(harness.state('a')?.seen).toEqual([
      { sessionId: 'chat-1', agent: { busy: true, lastActivityAt: T0 + 1_000 } },
      { sessionId: 'chat-1', agent: { busy: true, lastActivityAt: T0 + 1_000 }, manual: true, every: 600_000, instanceIds: ['a', 'b'] },
      {
        sessionId: 'chat-1',
        agent: { busy: false, lastActivityAt: T0 + 1_000, idleSince: T0 + 2_000 },
        manual: false,
        every: 120_000,
        instanceIds: ['a', 'b'],
      },
    ]);
    expect(harness.agent).toEqual({ busy: false, lastActivityAt: T0 + 1_000, idleSince: T0 + 2_000 });
    expect(harness.host.snapshot('a')?.agent).toEqual(harness.agent);
  });

  it('does not count a message the canvas sent, by its ID', async () => {
    const harness = await createTestCanvas(watcher, { now: () => T0 });
    cleanups.push(() => harness.close());
    await harness.open('a');
    await harness.invoke('a', 'nudge', {}, 'ui');
    harness.sessionEvent('user.message', { messageId: 'message-1', content: 'Watcher' });
    harness.sessionEvent('assistant.turn_start');
    expect(harness.agent).toEqual({ busy: true });
    harness.sessionEvent('user.message', { messageId: 'other', content: 'Thanks' });
    expect(harness.agent.lastActivityAt).toBe(T0);
  });

  it('reads the session history once, without counting live events twice', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'canvas-kit-activity-'));
    cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
    const handlers = new Set<(event: SessionEventLike) => void>();
    let release!: (events: SessionEventLike[]) => void;
    const session: CanvasSession = {
      sessionId: 'chat-2',
      on: handler => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      getEvents: () => new Promise(resolve => (release = resolve)),
    };
    const host = new CanvasHost(watcher, { dataRoot, session: Promise.resolve(session), jobs: 'manual', watch: false });
    cleanups.push(() => host.close());
    await host.open({ instanceId: 'a' });
    expect(host.sessionId).toBe('chat-2');

    const busy = { type: 'tool.execution_start', id: 'e2', timestamp: at(T0 + 2), data: { toolCallId: 'x', toolName: 'bash' } };
    for (const handler of handlers) handler(busy);
    // Live events wait for the history.
    expect(host.agent).toEqual({ busy: false });
    release([{ type: 'user.message', id: 'e1', timestamp: at(T0 + 1), data: { content: 'Start' } }, busy]);
    await expect.poll(() => host.agent).toEqual({ busy: true, lastActivityAt: T0 + 2 });
    expect(host.snapshot('a')?.agent).toEqual({ busy: true, lastActivityAt: T0 + 2 });

    for (const handler of handlers) handler({ type: 'session.idle', id: 'e3', timestamp: at(T0 + 3) });
    expect(host.agent).toEqual({ busy: false, lastActivityAt: T0 + 2, idleSince: T0 + 3 });
    await host.close();
    expect(handlers.size).toBe(0);
  });

  it('is idle when reopened in a chat whose agent has finished', async () => {
    const harness = await createTestCanvas(watcher, {
      now: () => T0 + 10_000,
      history: [
        { type: 'user.message', timestamp: at(T0), data: { content: 'Fix it' } },
        { type: 'assistant.turn_start', timestamp: at(T0 + 1) },
        { type: 'tool.execution_start', timestamp: at(T0 + 2), data: { toolCallId: 'a', toolName: 'edit' } },
        { type: 'assistant.turn_end', timestamp: at(T0 + 3) },
      ],
    });
    cleanups.push(() => harness.close());
    await harness.open('a');
    await expect.poll(() => harness.agent).toEqual({ busy: false, lastActivityAt: T0 + 2, idleSince: T0 + 3 });
  });

  it('works without a session', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'canvas-kit-activity-'));
    cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
    const host = new CanvasHost(watcher, { dataRoot, jobs: 'manual', watch: false });
    cleanups.push(() => host.close());
    await host.open({ instanceId: 'a' });
    await host.invoke({ instanceId: 'a', actionName: 'look', source: 'agent' });
    expect(host.snapshot('a')?.state).toEqual({ openedBy: 'none', seen: [{ sessionId: undefined, agent: { busy: false } }] });
  });
});
