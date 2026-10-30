import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineCanvas, z } from '../src/index.ts';
import { CanvasHost } from '../src/server/host.ts';
import { canvasDataDir } from '../src/server/storage.ts';
import { createTestCanvas } from '../src/testing.ts';

const messenger = defineCanvas({
  id: 'kit-agent-messenger',
  title: 'Messenger',
  description: 'Sends messages to the agent.',
  state: z.object({ sent: z.number().int() }),
  init: () => ({ sent: 0 }),
  actions: ({ action }) => ({
    ping_agent: action({
      description: 'Send a message to the agent.',
      input: z.object({ text: z.string().min(1) }),
      run: async (ctx, { text }) => {
        await ctx.sendToAgent({ prompt: `From ${ctx.instanceId}: ${text}`, displayPrompt: text });
        ctx.setState(state => ({ sent: state.sent + 1 }));
        return { dataDir: ctx.dataDir };
      },
    }),
  }),
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('agent messaging', () => {
  it('records messages in tests and exposes the private data folder', async () => {
    const canvas = await createTestCanvas(messenger);
    cleanups.push(() => canvas.close());
    await canvas.open('a');
    const result = await canvas.invoke('a', 'ping_agent', { text: 'hello' }, 'ui');
    expect(result).toEqual({ dataDir: canvasDataDir('kit-agent-messenger', canvas.dataRoot) });
    expect(canvas.sentToAgent).toEqual([{ prompt: 'From a: hello', displayPrompt: 'hello' }]);
    expect(canvas.state('a')).toEqual({ sent: 1 });
  });

  it('fails clearly without a session and rolls back state when sending fails', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'canvas-kit-agent-'));
    cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
    const host = new CanvasHost(messenger, { dataRoot });
    cleanups.push(() => host.close());
    await host.open({ instanceId: 'a' });
    await expect(host.invoke({ instanceId: 'a', actionName: 'ping_agent', input: { text: 'x' }, source: 'ui' })).rejects.toMatchObject({
      code: 'agent_unavailable',
      status: 503,
    });

    const failing = await createTestCanvas(messenger, {
      sendToAgent: async () => {
        throw new Error('session closed');
      },
    });
    cleanups.push(() => failing.close());
    await failing.open('a');
    await expect(failing.invoke('a', 'ping_agent', { text: 'x' })).rejects.toMatchObject({
      code: 'send_failed',
      message: 'Could not message the agent: session closed',
    });
    expect(failing.state('a')).toEqual({ sent: 0 });
  });
});
