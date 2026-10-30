#!/usr/bin/env node
// Test the packages the way someone outside this repository gets them: pack
// @rwoll/canvas-kit and @rwoll/create-canvas as npm would publish them, create a
// marketplace with the packed create-canvas, install the packed kit, and run the
// new marketplace's checks and browser tests.
//   node scripts/consumer-test.mjs [--keep] [--no-e2e]
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { keep: { type: 'boolean' }, 'no-e2e': { type: 'boolean' } } });

function run(command, args, cwd) {
  console.log(`\n$ ${command} ${args.join(' ')}   (in ${cwd})`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

const work = await mkdtemp(join(tmpdir(), 'canvas-kit-consumer-'));
try {
  const tarballs = join(work, 'tarballs');
  await mkdir(tarballs);
  for (const name of ['canvas-kit', 'create-canvas']) {
    run('pnpm', ['pack', '--pack-destination', tarballs], join(root, 'packages', name));
  }
  const files = await readdir(tarballs);
  const kit = join(tarballs, files.find(file => file.startsWith('rwoll-canvas-kit-')));
  const create = join(tarballs, files.find(file => file.startsWith('rwoll-create-canvas-')));

  // Run the packed create-canvas with the packed kit, as `npm create` would.
  const runner = join(work, 'runner');
  await mkdir(runner);
  await copyFile(join(root, '.npmrc'), join(runner, '.npmrc'));
  await writeFile(join(runner, 'package.json'), JSON.stringify({ name: 'runner', private: true, type: 'module' }));
  await writeFile(
    join(runner, 'pnpm-workspace.yaml'),
    `ignoreScripts: true\ntrustLockfile: true\noverrides:\n  '@rwoll/canvas-kit': ${JSON.stringify(`file:${kit}`)}\n`,
  );
  run('pnpm', ['add', `file:${create}`], runner);
  run('pnpm', ['exec', 'create-canvas', join(work, 'market'), '--repository', 'octo/market', '--canvas', 'board'], runner);

  // Point the new marketplace at the packed kit until it is on npm.
  const market = join(work, 'market');
  await copyFile(join(root, '.npmrc'), join(market, '.npmrc'));
  const workspace = await readFile(join(market, 'pnpm-workspace.yaml'), 'utf8');
  await writeFile(
    join(market, 'pnpm-workspace.yaml'),
    `${workspace}\ntrustLockfile: true\noverrides:\n  '@rwoll/canvas-kit': ${JSON.stringify(`file:${kit}`)}\n`,
  );
  run('pnpm', ['install'], market);
  run('pnpm', ['check'], market);
  if (!values['no-e2e']) {
    run('pnpm', ['--filter', 'board', 'exec', 'playwright', 'install', 'chromium'], market);
    run('pnpm', ['e2e'], market);
  }
  console.log(`\nConsumer test passed in ${market}.`);
} finally {
  if (values.keep) console.log(`Kept ${work}`);
  else await rm(work, { recursive: true, force: true });
}
