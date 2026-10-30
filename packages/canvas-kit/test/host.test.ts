import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CanvasClient } from '../src/client.ts';
import { CanvasKitError, defineCanvas, z } from '../src/index.ts';
import { contentSecurityPolicy, injectBootstrap } from '../src/server/host.ts';
import { StateStore, canvasDataDir } from '../src/server/storage.ts';
import { createTestCanvas, type TestCanvas } from '../src/testing.ts';
import { sample } from './sample.ts';

type Bootstrap = { base: string; token: string; revision: number; state: unknown };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function testCanvas<C extends Parameters<typeof createTestCanvas>[0]>(canvas: C, options?: Parameters<typeof createTestCanvas>[1]) {
  const harness = await createTestCanvas(canvas, options);
  cleanups.push(() => harness.close());
  return harness;
}

async function page(url: string): Promise<{ html: string; bootstrap: Bootstrap }> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  const html = await response.text();
  const json = /<script type="application\/json" id="canvas-kit-bootstrap">(.*?)<\/script>/s.exec(html)?.[1];
  expect(json).toBeDefined();
  return { html, bootstrap: JSON.parse(json!) as Bootstrap };
}

function rawRequest(url: string, headers: Record<string, string>, method = 'GET'): Promise<number> {
  return new Promise((done, fail) => {
    const req = request(url, { method, headers }, response => {
      response.resume();
      done(response.statusCode ?? 0);
    });
    req.on('error', fail);
    req.end();
  });
}

async function postAction(url: string, bootstrap: Bootstrap, name: string, body: unknown, headers: Record<string, string> = {}) {
  const origin = new URL(url).origin;
  return fetch(new URL(`__canvas/actions/${name}`, url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Canvas-Token': bootstrap.token, Origin: origin, ...headers },
    body: JSON.stringify(body),
  });
}

describe('CanvasHost', () => {
  it('opens instances idempotently on a loopback server', async () => {
    const canvas = await testCanvas(sample);
    const [first, concurrent] = await Promise.all([canvas.open('a', { start: 2 }), canvas.open('a', { start: 9 })]);
    expect(first.url).toBe(concurrent.url);
    expect(first.title).toBe('Sample');
    const url = new URL(first.url);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toMatch(/^\/c\/[0-9a-f]{32}\/$/);
    expect(canvas.state('a')).toEqual({ count: 2, label: 'items' });

    const other = await canvas.open('b');
    expect(new URL(other.url).origin).toBe(url.origin);
    expect(other.url).not.toBe(first.url);
    expect(canvas.state('b')).toEqual({ count: 0, label: 'items' });
  });

  it('embeds bootstrap data in the page and enforces host, origin, and token checks', async () => {
    const canvas = await testCanvas(sample);
    const { url } = await canvas.open('a');
    const { html, bootstrap } = await page(url);
    expect(html).toContain('<title>Sample</title>');
    expect(bootstrap).toMatchObject({ base: new URL(url).pathname, revision: 1, state: { count: 0, label: 'items' } });
    expect(bootstrap.token).toMatch(/^[0-9a-f]{64}$/);
    expect(url).not.toContain(bootstrap.token);

    const response = await fetch(url);
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(response.headers.get('content-security-policy')).toContain("; connect-src 'self'; ");
    await response.text();

    expect(await rawRequest(url, { Host: 'evil.example' })).toBe(403);
    expect(await rawRequest(new URL('__canvas/state', url).href, {})).toBe(403);
    expect(await rawRequest(new URL('__canvas/state', url).href, { 'X-Canvas-Token': bootstrap.token })).toBe(200);
    expect(await rawRequest(url, { Origin: 'http://evil.example' })).toBe(403);
    const redirect = await fetch(url.slice(0, -1), { redirect: 'manual' });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('location')).toBe(new URL(url).pathname);
  });

  it('adds only the declared connect-src sources to one canvas', async () => {
    const local = defineCanvas({
      id: 'kit-csp-canvas',
      title: 'CSP',
      description: 'Connects to local services.',
      state: z.object({}),
      init: () => ({}),
      csp: { connectSrc: ['ws://127.0.0.1:*', 'http://localhost:8080', 'ws://127.0.0.1:*'] },
    });
    const withCsp = await testCanvas(local);
    const plain = await testCanvas(sample);
    const policy = async (url: string) => {
      const response = await fetch(url);
      await response.text();
      return response.headers.get('content-security-policy');
    };
    const extended = await policy((await withCsp.open('a')).url);
    expect(extended).toContain("; connect-src 'self' ws://127.0.0.1:* http://localhost:8080; ");
    expect(extended).toContain("default-src 'none'");
    expect(extended).not.toContain('frame-src');
    expect(await policy((await plain.open('a')).url)).toBe(contentSecurityPolicy(sample.csp));
    expect(contentSecurityPolicy(sample.csp)).toContain("; connect-src 'self'; ");
  });

  it('recognizes CanvasKitErrors thrown by another copy of the kit', async () => {
    // The Vite dev server loads canvas code, and so the kit's errors module, separately from the kit itself.
    const copy: typeof import('../src/errors.ts') = await import(/* @vite-ignore */ `${'../src/errors.ts'}?copy`);
    expect(copy.CanvasKitError).not.toBe(CanvasKitError);
    const foreign = new copy.CanvasKitError('limit_reached', 'Too many', 409);
    expect(foreign instanceof CanvasKitError).toBe(true);
    expect(new Error('plain') instanceof CanvasKitError).toBe(false);
    expect((null as unknown as object) instanceof CanvasKitError).toBe(false);
    class Narrower extends CanvasKitError {}
    expect(foreign instanceof Narrower).toBe(false);
    expect(new Narrower('x', 'y') instanceof CanvasKitError).toBe(true);

    const failing = defineCanvas({
      id: 'kit-foreign-error',
      title: 'Foreign',
      description: 'Throws an error from another module copy.',
      state: z.object({}),
      init: () => ({}),
      actions: ({ action }) => ({
        fail: action({
          description: 'Always fails.',
          run: () => {
            throw foreign;
          },
        }),
      }),
    });
    const canvas = await testCanvas(failing);
    const { url } = await canvas.open('a');
    const { bootstrap } = await page(url);
    const response = await postAction(url, bootstrap, 'fail', {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, code: 'limit_reached', message: 'Too many' });
  });

  it('runs UI actions with validation and exposure rules', async () => {
    const canvas = await testCanvas(sample);
    const { url } = await canvas.open('a');
    const { bootstrap } = await page(url);

    const ok = await postAction(url, bootstrap, 'increment', { by: 3 });
    expect(await ok.json()).toEqual({ ok: true, result: 3 });
    expect(canvas.state('a')!.count).toBe(3);

    const invalid = await postAction(url, bootstrap, 'increment', { by: 0 });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ ok: false, code: 'invalid_input' });

    const agentOnly = await postAction(url, bootstrap, 'reset', {});
    expect(agentOnly.status).toBe(404);
    await agentOnly.text();

    const crossOrigin = await postAction(url, bootstrap, 'increment', {}, { Origin: 'http://evil.example' });
    expect(crossOrigin.status).toBe(403);
    await crossOrigin.text();

    expect(await canvas.invoke('a', 'ping', {}, 'ui')).toBe('pong');
    await expect(canvas.invoke('a', 'ping', {})).rejects.toMatchObject({ code: 'not_found' });
    await canvas.invoke('a', 'reset', {});
    expect(canvas.state('a')!.count).toBe(0);
    expect(await canvas.invoke('a', 'get_state')).toEqual({ count: 0, label: 'items' });
  });

  it('runs agent actions for the dev server', async () => {
    const canvas = await testCanvas(sample);
    await canvas.open('a', { start: 5 });
    const server = createServer((req, res) => {
      const name = req.url!.slice(1);
      canvas.host.runDevAgentAction('a', name, req, res).catch(error => canvas.host.sendError(res, error));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise(resolve => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const post = (name: string, body?: unknown) =>
      fetch(base + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

    const reset = await post('reset');
    expect(await reset.json()).toEqual({ ok: true, result: null });
    expect(canvas.state('a')!.count).toBe(0);
    const uiOnly = await post('ping', {});
    expect(uiOnly.status).toBe(404);
    await uiOnly.text();
  });

  it('requires an open instance for agent actions and stops the server after the last close', async () => {
    const canvas = await testCanvas(sample);
    await expect(canvas.invoke('missing', 'increment', {})).rejects.toMatchObject({ code: 'not_open' });
    const { url } = await canvas.open('a');
    const other = await canvas.open('b');
    await canvas.host.closeInstance('a');
    const closed = await fetch(url);
    expect(closed.status).toBe(404);
    await closed.text();
    await expect(canvas.invoke('a', 'increment', {})).rejects.toMatchObject({ code: 'not_open' });

    await canvas.host.closeInstance('b');
    await expect(fetch(other.url, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
    const reopened = await canvas.open('a');
    expect(reopened.url).not.toBe(url);
    const page = await fetch(reopened.url);
    expect(page.status).toBe(200);
    await page.text();
  });

  it('pushes live state to the browser client', async () => {
    const canvas = await testCanvas(sample);
    const { url } = await canvas.open('a');
    const { bootstrap } = await page(url);
    const origin = new URL(url).origin;
    const client = new CanvasClient<typeof sample>(
      { ...bootstrap, base: url },
      { fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), Origin: origin } }) },
    );
    cleanups.push(async () => client.close());
    const seen: number[] = [];
    const live = new Promise<void>(done => {
      const stop = client.subscribe(() => {
        const snapshot = client.getSnapshot();
        if (snapshot.status !== 'live') return;
        seen.push(snapshot.state.count);
        if (snapshot.state.count === 5) {
          stop();
          done();
        }
      });
    });
    expect(client.getSnapshot()).toMatchObject({ status: 'connecting', revision: 1, state: { count: 0 } });
    await expect(client.run('increment', { by: 5 })).resolves.toBe(5);
    await live;
    expect(seen.at(-1)).toBe(5);
    await expect(client.run('reset' as never)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('injects bootstrap data safely, including replacement patterns and closing tags', () => {
    const state = { message: "price $' $& $` </script><b>" };
    const html = injectBootstrap('<html><head><title>T</title></head><body></body></html>', { base: '/', token: 't', revision: 1, state });
    const json = /id="canvas-kit-bootstrap">(.*?)<\/script>/s.exec(html)?.[1];
    expect(JSON.parse(json!).state).toEqual(state);
    expect(html.endsWith('</head><body></body></html>')).toBe(true);
  });

  it('serves built UI assets without path traversal', async () => {
    const uiDir = await mkdtemp(join(tmpdir(), 'canvas-kit-ui-'));
    cleanups.push(() => rm(uiDir, { recursive: true, force: true }));
    await mkdir(join(uiDir, 'assets'));
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><html><head><title>UI</title></head><body></body></html>');
    await writeFile(join(uiDir, 'assets', 'app.js'), 'export {};');
    const canvas = await testCanvas(sample, { uiDir });
    const { url } = await canvas.open('a');
    const { html } = await page(url);
    expect(html).toContain('<title>UI</title>');
    const script = await fetch(new URL('assets/app.js', url));
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await script.text()).toBe('export {};');
    expect(await rawRequest(new URL('assets/%2e%2e/%2e%2e/package.json', url).href, {})).toBe(404);
    expect(await rawRequest(new URL('assets/missing.js', url).href, {})).toBe(404);
  });
});

describe('persistence', () => {
  const notes = defineCanvas({
    id: 'kit-notes-canvas',
    title: 'Notes',
    description: 'Persistent notes.',
    state: z.object({ text: z.string() }),
    input: z.object({ doc: z.string() }),
    persist: { key: ({ input }) => input.doc },
    init: () => ({ text: '' }),
    reopen: ({ state, input }) => (input.doc === 'fresh' ? { text: `${state.text}!` } : undefined),
    actions: ({ action }) => ({
      write: action({
        description: 'Replace the text.',
        input: z.object({ text: z.string() }),
        run: (ctx, { text }) => {
          ctx.setState({ text });
        },
      }),
      append: action({
        description: 'Append text after a pause.',
        input: z.object({ text: z.string() }),
        run: async (ctx, { text }) => {
          await new Promise(done => setTimeout(done, 5));
          ctx.setState(state => ({ text: state.text + text }));
        },
      }),
      fail_after_write: action({
        description: 'Change the text, then fail.',
        run: ctx => {
          ctx.setState({ text: 'partial' });
          throw new CanvasKitError('boom', 'failed after writing');
        },
      }),
    }),
  });

  async function shared(): Promise<string> {
    const dataRoot = await mkdtemp(join(tmpdir(), 'canvas-kit-data-'));
    cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));
    return dataRoot;
  }

  it('restores state by domain key across hosts and instances', async () => {
    const dataRoot = await shared();
    const first: TestCanvas<typeof notes> = await testCanvas(notes, { dataRoot });
    await first.open('panel-1', { doc: 'readme' });
    await first.invoke('panel-1', 'write', { text: 'hello' });
    await first.close();

    const store = new StateStore(canvasDataDir('kit-notes-canvas', dataRoot), notes.state, 1);
    const saved = JSON.parse(await readFile(store.fileFor('readme'), 'utf8'));
    expect(saved).toMatchObject({ format: 'rwoll-canvas-kit-state', version: 1, key: 'readme', state: { text: 'hello' } });

    const second = await testCanvas(notes, { dataRoot });
    await second.open('another-panel', { doc: 'readme' });
    expect(second.state('another-panel')).toEqual({ text: 'hello' });
    await second.open('other-doc', { doc: 'other' });
    expect(second.state('other-doc')).toEqual({ text: '' });
  });

  it('applies reopen() to live and restored instances', async () => {
    const dataRoot = await shared();
    const canvas = await testCanvas(notes, { dataRoot });
    await canvas.open('a', { doc: 'fresh' });
    expect(canvas.state('a')).toEqual({ text: '' });
    await canvas.open('a', { doc: 'fresh' });
    expect(canvas.state('a')).toEqual({ text: '!' });
  });

  it('switches documents when reopened with input for a different key', async () => {
    const dataRoot = await shared();
    const canvas = await testCanvas(notes, { dataRoot });
    await canvas.open('panel', { doc: 'a' });
    await canvas.invoke('panel', 'write', { text: 'alpha' });
    await canvas.open('panel', { doc: 'b' });
    expect(canvas.state('panel')).toEqual({ text: '' });
    await canvas.invoke('panel', 'write', { text: 'beta' });
    await canvas.open('panel', { doc: 'a' });
    expect(canvas.state('panel')).toEqual({ text: 'alpha' });
    const store = new StateStore(canvasDataDir('kit-notes-canvas', dataRoot), notes.state, 1);
    expect(await store.load('a')).toEqual({ text: 'alpha' });
    expect(await store.load('b')).toEqual({ text: 'beta' });
  });

  it('shares live state between instances of the same document without losing updates', async () => {
    const dataRoot = await shared();
    const canvas = await testCanvas(notes, { dataRoot });
    await canvas.open('x', { doc: 'shared' });
    await canvas.open('y', { doc: 'shared' });
    await canvas.invoke('x', 'write', { text: 'one' });
    expect(canvas.state('y')).toEqual({ text: 'one' });
    await Promise.all([canvas.invoke('x', 'append', { text: '1' }), canvas.invoke('y', 'append', { text: '2' })]);
    expect(canvas.state('x')).toEqual({ text: 'one12' });
    expect(canvas.state('y')).toEqual({ text: 'one12' });

    await canvas.host.closeInstance('x');
    expect(canvas.state('y')).toEqual({ text: 'one12' });
    await canvas.host.closeInstance('y');
    await canvas.open('z', { doc: 'shared' });
    expect(canvas.state('z')).toEqual({ text: 'one12' });
  });

  it('rolls back state when an action fails or its state cannot be saved', async () => {
    const dataRoot = await shared();
    const canvas = await testCanvas(notes, { dataRoot });
    await canvas.open('a', { doc: 'rollback' });
    await canvas.invoke('a', 'write', { text: 'kept' });
    await expect(canvas.invoke('a', 'fail_after_write')).rejects.toMatchObject({ code: 'boom' });
    expect(canvas.state('a')).toEqual({ text: 'kept' });

    const store = new StateStore(canvasDataDir('kit-notes-canvas', dataRoot), notes.state, 1);
    if (process.getuid?.() === 0) return;
    const folder = join(store.fileFor('rollback'), '..');
    await chmod(folder, 0o500);
    try {
      await expect(canvas.invoke('a', 'write', { text: 'unsaved' })).rejects.toMatchObject({ code: 'storage_error' });
    } finally {
      await chmod(folder, 0o700);
    }
    expect(canvas.state('a')).toEqual({ text: 'kept' });
    expect(await store.load('rollback')).toEqual({ text: 'kept' });
  });

  it('reports corrupt or incompatible files instead of overwriting them', async () => {
    const dataRoot = await shared();
    const store = new StateStore(canvasDataDir('kit-notes-canvas', dataRoot), notes.state, 1);
    const file = store.fileFor('broken');
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, '{not json');
    const canvas = await testCanvas(notes, { dataRoot });
    await expect(canvas.open('a', { doc: 'broken' })).rejects.toMatchObject({ code: 'corrupt_state' });
    expect(await readFile(file, 'utf8')).toBe('{not json');

    await new StateStore(canvasDataDir('kit-notes-canvas', dataRoot), notes.state, 2).save('newer', { text: 'v2' });
    await expect(canvas.open('b', { doc: 'newer' })).rejects.toMatchObject({ code: 'unsupported_state' });
    await expect(canvas.open('c', { doc: 7 })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
