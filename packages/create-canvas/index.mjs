#!/usr/bin/env node
// npm create @rwoll/canvas [folder] -- [--repository owner/name] [--canvas name]
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { CliError, initMarketplace } from '@rwoll/canvas-kit/cli';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repository: { type: 'string' },
    canvas: { type: 'string' },
    name: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log('Usage: npm create @rwoll/canvas [folder] -- [--repository owner/name] [--canvas name] [--name marketplace-name]');
  process.exit(0);
}

async function ask(question, fallback) {
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question}${fallback ? ` (${fallback})` : ''}: `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

try {
  const folder = positionals[0] ?? (await ask('Folder', 'my-marketplace'));
  const dir = resolve(folder);
  const name = values.name ?? basename(dir);
  const repository = values.repository ?? (await ask('GitHub repository (owner/name)', undefined));
  if (!repository) throw new CliError('pass --repository owner/name');
  const canvas = values.canvas ?? (await ask('First canvas name', 'hello-canvas'));
  await initMarketplace(dir, { name, owner: repository.split('/')[0], repository, canvas });
  console.log(`\nCreated ${name} in ${dir}.\n\nNext:\n  cd ${folder}\n  pnpm install\n  pnpm --filter ${canvas} dev\n  pnpm check\n\nPush to ${repository} and every push to main publishes the marketplace to its stable branch.`);
} catch (error) {
  if (error instanceof CliError) {
    console.error(`create-canvas: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
