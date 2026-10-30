import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { errorMessage } from '../errors.ts';

/**
 * Which build of a canvas is running. `published` builds carry the stamp that
 * `canvas-kit release` writes to `<plugin>/release.json`; other builds are `local`, and
 * the Vite dev server is `dev`.
 */
export interface ReleaseInfo {
  name: string;
  version: string;
  channel: 'published' | 'local' | 'dev';
  /** ISO timestamp of the release that last changed this plugin. */
  publishedAt?: string;
  /** Full SHA of the source commit that release was built from. */
  sourceCommit?: string;
}

const stampSchema = z.object({
  publishedAt: z.iso.datetime(),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
});

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

/** Read the release stamp next to a plugin. A missing stamp means a local build. */
export async function loadRelease(
  file: string,
  plugin: { name: string; version: string },
): Promise<{ release: ReleaseInfo; warning?: string }> {
  const local: ReleaseInfo = { ...plugin, channel: 'local' };
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { release: local };
    return { release: local, warning: `Cannot read ${file}: ${errorMessage(error)}` };
  }
  let parsed: ReturnType<typeof stampSchema.safeParse>;
  try {
    parsed = stampSchema.safeParse(JSON.parse(content));
  } catch {
    return { release: local, warning: `${file} is not valid JSON` };
  }
  if (!parsed.success) return { release: local, warning: `${file} is not a valid release stamp` };
  return { release: { ...plugin, channel: 'published', ...parsed.data } };
}

// The footer is fixed to the bottom of the viewport. A spacer of the same height
// at the end of the page keeps the last content scrollable above it.
const FOOTER_HEIGHT = '28px';
const FOOTER_STYLE =
  `.canvas-kit-release{position:fixed;left:0;right:0;bottom:0;z-index:100;box-sizing:border-box;` +
  `height:${FOOTER_HEIGHT};margin:0;padding:0 12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;` +
  'border-top:1px solid var(--border,rgba(128,128,128,.3));background:var(--bg,Canvas);' +
  `color:var(--muted,GrayText);font:12px/calc(${FOOTER_HEIGHT} - 1px) system-ui,sans-serif;text-align:start}` +
  `.canvas-kit-release-spacer{height:${FOOTER_HEIGHT}}` +
  `html{scroll-padding-bottom:${FOOTER_HEIGHT}}`;

const defaultFormat = (date: Date) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);

/** The footer text as HTML, for example `hello-canvas v0.2.2 · Published Oct 22, 2026, 7:45 PM`. */
export function renderReleaseFooter(release: ReleaseInfo, format: (date: Date) => string = defaultFormat): string {
  const label = `${escapeHtml(release.name)} v${escapeHtml(release.version)}`;
  let detail: string;
  if (release.channel === 'published' && release.publishedAt) {
    const title = release.sourceCommit ? ` title="Built from commit ${escapeHtml(release.sourceCommit)}"` : '';
    const text = escapeHtml(format(new Date(release.publishedAt)));
    detail = `Published <time datetime="${escapeHtml(release.publishedAt)}"${title}>${text}</time>`;
  } else {
    detail = release.channel === 'dev' ? 'Dev server' : 'Local build, not published';
  }
  return `<footer class="canvas-kit-release">${label} · ${detail}</footer>`;
}

/** Insert `snippet` before the last match of `tag`, or at `fallback` when the tag is missing. */
export function insertBefore(html: string, tag: RegExp, snippet: string, fallback: 'start' | 'end'): string {
  let index = -1;
  for (const match of html.matchAll(new RegExp(tag.source, 'gi'))) index = match.index;
  if (index < 0) return fallback === 'start' ? `${snippet}\n${html}` : `${html}\n${snippet}`;
  return `${html.slice(0, index)}${snippet}\n${html.slice(index)}`;
}

/** Add the release footer, its spacer, and its styles to a page. */
export function injectReleaseFooter(html: string, release: ReleaseInfo): string {
  const styled = insertBefore(html, /<\/head>/, `<style>${FOOTER_STYLE}</style>`, 'start');
  const footer = `<div class="canvas-kit-release-spacer" aria-hidden="true"></div>${renderReleaseFooter(release)}`;
  return insertBefore(styled, /<\/body>/, footer, 'end');
}
