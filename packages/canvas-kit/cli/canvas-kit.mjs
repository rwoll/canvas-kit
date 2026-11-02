#!/usr/bin/env node
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CliError, addUi, buildMarketplace, initMarketplace, kitVersion, newCanvas, release, runJob } from './lib.mjs';

const USAGE = `Usage: canvas-kit <command> [options]

Commands:
  init <dir> --repository <owner/name> [--name <name>] [--owner <name>] [--canvas <name>]
      Create a plugin marketplace repository: one canvas project with a shared ui/
      folder, optionally with a first canvas.
  new <name> [--title <text>] [--description <text>] [--id <canvas-id>]
      Add a canvas to the project: canvases/<name>/ with canvas.ts, App.tsx, and tests.
      It uses the project's shared ui/ folder when there is one.
  ui
      Add a shared ui/ folder of React components and a theme that new canvases use.
  build
      Assemble dist/marketplace from plugins/ and the plugins \`vite build\` wrote to dist/plugins/.
  release [--dry-run] [--skip-checks] [--footer <text>]... [--bundle <file> [--github-output]]
      Build the source branch in a clean worktree and publish it to the publish branch.
      With --bundle, write the prepared commit to a git bundle instead of pushing it;
      --github-output also writes the commit and branch step outputs.
  run [job] [--plugin <folder>] [--canvas <name>] [--key <key>] [--force] [--data-root <folder>]
      Run a canvas's due jobs for its saved documents, with no chat open: every job,
      or one job by name or ID. For launchd, cron, or Task Scheduler. --plugin
      defaults to every plugin in ./dist/plugins; --canvas picks the canvas by folder
      name or ID when there are several.

Options:
  --cwd <dir>     Project folder (default: current folder)
  -h, --help      Show this help
  -v, --version   Show the canvas-kit version

The marketplace folder holds marketplace.config.json.`;

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cwd: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      title: { type: 'string' },
      description: { type: 'string' },
      id: { type: 'string' },
      name: { type: 'string' },
      owner: { type: 'string' },
      repository: { type: 'string' },
      canvas: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'skip-checks': { type: 'boolean' },
      footer: { type: 'string', multiple: true },
      bundle: { type: 'string' },
      'github-output': { type: 'boolean' },
      plugin: { type: 'string' },
      key: { type: 'string' },
      force: { type: 'boolean' },
      'data-root': { type: 'string' },
    },
  });
  const [command, ...rest] = positionals;
  if (values.version) return console.log(await kitVersion());
  if (values.help || !command) return console.log(USAGE);
  const dir = resolve(values.cwd ?? '.');

  switch (command) {
    case 'init': {
      const [target] = rest;
      if (!target) throw new CliError('init needs a folder, for example `canvas-kit init my-marketplace --repository me/my-marketplace`');
      if (!values.repository) throw new CliError('init needs --repository <owner/name>');
      const folder = resolve(dir, target);
      const name = values.name ?? basename(folder);
      const owner = values.owner ?? values.repository.split('/')[0];
      const { canvas } = await initMarketplace(folder, { name, owner, repository: values.repository, canvas: values.canvas });
      console.log(
        `Created ${name} in ${folder}${canvas ? ` with the ${canvas.name} canvas` : ''}.\n\nNext:\n  cd ${target}\n  pnpm install\n` +
          (canvas ? '  pnpm dev\n  pnpm check' : '  pnpm new-canvas <name>\n  pnpm dev'),
      );
      return;
    }
    case 'new': {
      const [name] = rest;
      if (!name) throw new CliError('new needs a canvas name, for example `canvas-kit new release-board`');
      const canvas = await newCanvas(dir, name, { title: values.title, description: values.description, id: values.id });
      console.log(`Created ${canvas.dir} (canvas id "${canvas.id}"). Run your dev script to preview it.`);
      return;
    }
    case 'ui': {
      const ui = await addUi(dir);
      console.log(`Created ${ui.dir}. Import its components from '../../ui' and its theme.css in each canvas's App.tsx; new canvases do this for you.`);
      return;
    }
    case 'build': {
      const { catalog, outDir } = await buildMarketplace(dir);
      console.log(`Built ${catalog.name} with ${catalog.plugins.length} plugins in ${outDir}:`);
      for (const plugin of catalog.plugins) console.log(`  ${plugin.name}@${plugin.version}`);
      return;
    }
    case 'run': {
      const [job] = rest;
      const outcomes = await runJob(dir, job, {
        plugin: values.plugin,
        canvas: values.canvas,
        key: values.key,
        force: values.force,
        dataRoot: values['data-root'],
        log: (message, level) => console.error(`[${level}] ${message}`),
      });
      if (outcomes.length === 0) console.log('Nothing to run: no saved document has this job yet.');
      for (const outcome of outcomes) {
        const result = outcome.error ? `failed: ${outcome.error}` : outcome.ran ? 'ran' : outcome.paused ? 'paused' : 'not due';
        console.log(`${outcome.key} ${outcome.id ?? outcome.job}: ${result}`);
      }
      if (outcomes.some(outcome => outcome.error)) process.exitCode = 1;
      return;
    }
    case 'release':
      await release(dir, {
        dryRun: values['dry-run'],
        skipChecks: values['skip-checks'],
        footer: values.footer ?? [],
        bundle: values.bundle,
        githubOutput: values['github-output'],
      });
      return;
    default:
      throw new CliError(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch(error => {
  if (error instanceof CliError || error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    console.error(`canvas-kit: ${error.message}`);
    process.exit(1);
  }
  throw error;
});
