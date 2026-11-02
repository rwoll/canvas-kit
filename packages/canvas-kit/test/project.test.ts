import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineCanvas, z } from '../src/index.ts';
import { pickCanvas } from '../src/server/headless.ts';
import { findCanvases, pageHtml, planPlugins } from '../src/vite.ts';

const sdk = vi.hoisted(() => ({ joined: [] as { canvases: { id: string; open: (ctx: unknown) => Promise<unknown> }[] }[] }));
vi.mock('@github/copilot-sdk/extension', () => ({
  CanvasError: class CanvasError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  createCanvas: (spec: unknown) => spec,
  joinSession: async (options: (typeof sdk.joined)[number]) => {
    sdk.joined.push(options);
    return { sessionId: 'chat-1', log: async () => {}, send: async () => 'm1', on: () => () => {}, getEvents: async () => [] };
  },
}));

const counter = (id: string) =>
  defineCanvas({ id, title: id, description: `The ${id} canvas.`, state: z.object({ n: z.number() }), init: () => ({ n: 0 }) });

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const project = { name: 'demo', version: '1.2.0', description: 'Demo canvases.' };

describe('projects', () => {
  it('finds canvas folders with a canvas.ts and an App.tsx', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-kit-project-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    expect(findCanvases(root)).toEqual([]);
    for (const name of ['board', 'notes']) {
      await mkdir(join(root, 'canvases', name), { recursive: true });
      await writeFile(join(root, 'canvases', name, 'canvas.ts'), '');
      await writeFile(join(root, 'canvases', name, 'App.tsx'), '');
    }
    await mkdir(join(root, 'canvases', 'helpers'), { recursive: true });
    expect(findCanvases(root)).toEqual(['board', 'notes']);
    await rm(join(root, 'canvases', 'notes', 'App.tsx'));
    expect(() => findCanvases(root)).toThrow('canvases/notes has canvas.ts but no App.tsx');
  });

  it('puts every canvas and the skills in one plugin, or splits some off', () => {
    expect(planPlugins(project, ['board', 'notes', 'summary'], true)).toEqual([
      { name: 'demo', version: '1.2.0', description: 'Demo canvases.', canvases: ['board', 'notes', 'summary'], skills: true },
    ]);
    const split = planPlugins(project, ['board', 'notes', 'summary'], true, [{ name: 'summary', description: 'Summary.', canvases: ['summary'], version: '2.0.0' }]);
    expect(split).toEqual([
      { name: 'demo', version: '1.2.0', description: 'Demo canvases.', canvases: ['board', 'notes'], skills: true },
      { name: 'summary', version: '2.0.0', description: 'Summary.', canvases: ['summary'], skills: false },
    ]);
    // With every canvas split off and no skills, there is no main plugin.
    expect(planPlugins(project, ['summary'], false, [{ name: 'summary', description: 'Summary.', canvases: ['summary'] }]).map(plan => plan.name)).toEqual(['summary']);
    expect(planPlugins(project, [], false)).toEqual([]);

    expect(() => planPlugins(project, ['board'], false, [{ name: 'demo', description: 'x', canvases: ['board'] }])).toThrow('Two plugins are named demo');
    expect(() => planPlugins(project, ['board'], false, [{ name: 'other', description: 'x', canvases: ['nope'] }])).toThrow(/lists nope/);
    expect(() =>
      planPlugins(project, ['board'], false, [
        { name: 'a', description: 'x', canvases: ['board'] },
        { name: 'b', description: 'x', canvases: ['board'] },
      ]),
    ).toThrow('board is in both a and b');
    expect(() => planPlugins(project, ['board'], false, [{ name: 'Bad', description: 'x', canvases: ['board'] }])).toThrow(/kebab-case/);
  });

  it('generates a page per canvas', () => {
    expect(pageHtml('board')).toContain('<script type="module" src="/__canvas-kit/main/board.js"></script>');
    expect(pageHtml('board')).not.toContain('<title>');
  });

  it('picks a plugin canvas by folder name or ID', () => {
    const entries = [
      { name: 'board', canvas: counter('octo-board') },
      { name: 'notes', canvas: counter('octo-notes') },
    ];
    expect(pickCanvas(entries, 'notes')).toBe(entries[1]);
    expect(pickCanvas(entries, 'octo-board')).toBe(entries[0]);
    expect(pickCanvas([entries[0]!])).toBe(entries[0]);
    expect(() => pickCanvas(entries)).toThrow(/several canvases \(board, notes\)/);
    expect(() => pickCanvas(entries, 'nope')).toThrow('No canvas nope in this plugin. Its canvases: board, notes.');
  });
});

describe('runCanvasExtension', () => {
  it('registers every canvas in one session, each serving its own page', async () => {
    const { runCanvasExtension } = await import('../src/extension.ts');
    const uiDir = await mkdtemp(join(tmpdir(), 'canvas-kit-ui-'));
    cleanups.push(() => rm(uiDir, { recursive: true, force: true }));
    await writeFile(join(uiDir, 'board.html'), '<html><head></head><body>board page</body></html>');
    await writeFile(join(uiDir, 'notes.html'), '<html><head></head><body>notes page</body></html>');
    const { hosts, session } = await runCanvasExtension(
      [
        { name: 'board', page: 'board.html', canvas: counter('kit-board') },
        { name: 'notes', page: 'notes.html', canvas: counter('kit-notes') },
      ],
      { uiDir, releaseFile: join(uiDir, 'release.json'), plugin: { name: 'demo', version: '1.0.0' } },
    );
    cleanups.push(() => Promise.all(hosts.map(host => host.close())));
    expect(session.sessionId).toBe('chat-1');
    expect(sdk.joined).toHaveLength(1);
    expect(sdk.joined[0]!.canvases.map(canvas => canvas.id)).toEqual(['kit-board', 'kit-notes']);

    const { url } = (await sdk.joined[0]!.canvases[1]!.open({ instanceId: 'a' })) as { url: string };
    const page = await (await fetch(url)).text();
    expect(page).toContain('notes page');
    expect(page).toContain('<title>kit-notes</title>');
    expect(hosts[1]!.sessionId).toBe('chat-1');

    await expect(
      runCanvasExtension([counter('same'), counter('same')], { uiDir, releaseFile: join(uiDir, 'release.json'), plugin: { name: 'demo', version: '1.0.0' } }),
    ).rejects.toThrow('Two canvases in demo have the ID same');
  });
});
