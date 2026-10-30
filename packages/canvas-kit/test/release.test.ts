import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineCanvas, z } from '../src/index.ts';
import { injectReleaseFooter, loadRelease, renderReleaseFooter, type ReleaseInfo } from '../src/server/release.ts';
import { createTestCanvas } from '../src/testing.ts';

const commit = 'b'.repeat(40);
const format = (date: Date) => date.toISOString().slice(0, 16);
const published: ReleaseInfo = {
  name: 'demo',
  version: '1.2.3',
  channel: 'published',
  publishedAt: '2026-10-23T02:40:00.000Z',
  sourceCommit: commit,
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function stampFile(content?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-kit-release-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'release.json');
  if (content !== undefined) await writeFile(file, content);
  return file;
}

describe('release footer', () => {
  it('renders published, local, and dev builds with escaping', () => {
    expect(renderReleaseFooter(published, format)).toBe(
      `<footer class="canvas-kit-release">demo v1.2.3 · Published <time datetime="2026-10-23T02:40:00.000Z" title="Built from commit ${commit}">2026-10-23T02:40</time></footer>`,
    );
    expect(renderReleaseFooter({ name: 'demo', version: '1.0.0', channel: 'local' })).toBe(
      '<footer class="canvas-kit-release">demo v1.0.0 · Local build, not published</footer>',
    );
    expect(renderReleaseFooter({ name: '<x>', version: '1"', channel: 'dev' })).toBe(
      '<footer class="canvas-kit-release">&#60;x&#62; v1&#34; · Dev server</footer>',
    );
  });

  it('pins the footer to the viewport bottom with a spacer and styles in the head', () => {
    const html = injectReleaseFooter('<html><head><title>T</title></head><body><div id="root"></div></body></html>', published);
    expect(html).toMatch(/<style>\.canvas-kit-release\{position:fixed;left:0;right:0;bottom:0;[^<]+\.canvas-kit-release-spacer\{height:28px\}[^<]*<\/style>\n<\/head>/);
    expect(html).toMatch(
      /<\/div><div class="canvas-kit-release-spacer" aria-hidden="true"><\/div><footer class="canvas-kit-release">demo v1\.2\.3 · Published <time [^>]+>[^<]+<\/time><\/footer>\n<\/body><\/html>$/,
    );
    expect(injectReleaseFooter('<p>bare</p>', published)).toMatch(/^<style>[\s\S]+<p>bare<\/p>\n<div class="canvas-kit-release-spacer"/);
  });

  it('loads release stamps and treats missing or invalid ones as local builds', async () => {
    const plugin = { name: 'demo', version: '1.2.3' };
    expect(await loadRelease(await stampFile(), plugin)).toEqual({ release: { ...plugin, channel: 'local' } });
    const valid = await stampFile(JSON.stringify({ name: 'demo', version: '1.2.3', publishedAt: published.publishedAt, sourceCommit: commit }));
    expect(await loadRelease(valid, plugin)).toEqual({ release: published });
    for (const bad of ['{nope', JSON.stringify({ publishedAt: 'later', sourceCommit: commit })]) {
      const result = await loadRelease(await stampFile(bad), plugin);
      expect(result.release).toEqual({ ...plugin, channel: 'local' });
      expect(result.warning).toMatch(/release\.json is not/);
    }
  });

  it('is served by default and can be turned off per canvas', async () => {
    const base = { title: 'Demo', description: 'Demo canvas.', state: z.object({}), init: () => ({}) };
    const shown = await createTestCanvas(defineCanvas({ ...base, id: 'kit-footer-shown' }), { release: published });
    cleanups.push(() => shown.close());
    const page = await (await fetch((await shown.open('a')).url)).text();
    expect(page).toContain('<footer class="canvas-kit-release">demo v1.2.3 · Published');
    const bootstrap = JSON.parse(/id="canvas-kit-bootstrap">(.*?)<\/script>/s.exec(page)![1]!);
    expect(bootstrap.release).toEqual(published);

    const hidden = await createTestCanvas(defineCanvas({ ...base, id: 'kit-footer-hidden', versionFooter: false }), { release: published });
    cleanups.push(() => hidden.close());
    const hiddenPage = await (await fetch((await hidden.open('a')).url)).text();
    expect(hiddenPage).not.toContain('canvas-kit-release');
    expect(hiddenPage).toContain('"release":');
  });
});
