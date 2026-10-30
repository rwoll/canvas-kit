// Render docs/hero/hero.html to the README hero images: pnpm hero
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const page = new URL('./hero.html', import.meta.url).href;
const browser = await chromium.launch();
try {
  for (const scheme of ['light', 'dark']) {
    const tab = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, colorScheme: scheme });
    await tab.goto(page);
    if (scheme === 'dark') await tab.evaluate(() => document.documentElement.classList.add('dark'));
    await tab.evaluate(() => document.fonts.ready);
    const path = fileURLToPath(new URL(`../hero-${scheme}.png`, import.meta.url));
    await tab.screenshot({ path });
    console.log(`Wrote ${path}`);
    await tab.close();
  }
} finally {
  await browser.close();
}
