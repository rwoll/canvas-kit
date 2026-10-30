import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('./index.mjs', import.meta.url));
let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'create-canvas-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

it('creates a marketplace with a first canvas', async () => {
  const output = execFileSync(process.execPath, [bin, 'my-market', '--repository', 'octo/my-market', '--canvas', 'board'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  expect(output).toContain('Created my-market');
  const config = JSON.parse(await readFile(join(dir, 'my-market', 'marketplace.config.json'), 'utf8'));
  expect(config).toMatchObject({ name: 'my-market', owner: { name: 'octo' }, repository: 'octo/my-market' });
  const pkg = JSON.parse(await readFile(join(dir, 'my-market', 'canvases', 'board', 'package.json'), 'utf8'));
  expect(pkg.name).toBe('board');
});

it('explains what is missing without a terminal to ask in', () => {
  const result = spawnSync(process.execPath, [bin, 'my-market'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('pass --repository owner/name');
});
