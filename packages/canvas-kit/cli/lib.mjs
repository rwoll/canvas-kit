// Library behind the `canvas-kit` command and `@rwoll/create-canvas`. Plain ESM so it
// runs without a build step, including from a workspace checkout of the kit.
import { execFileSync, spawnSync } from 'node:child_process';
import { access, appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const kitRoot = fileURLToPath(new URL('..', import.meta.url));
const templateDir = join(kitRoot, 'templates', 'canvas');
const uiTemplateDir = join(kitRoot, 'templates', 'ui');

/** The repository that hosts the reusable workflow. Update when the repository is renamed. */
export const KIT_REPOSITORY = 'rwoll/canvas-kit';
export const CONFIG_FILE = 'marketplace.config.json';
export const STAMP_FILE = 'release.json';
const MANIFESTS = ['.plugin/plugin.json', 'plugin.json', '.github/plugin/plugin.json', '.claude-plugin/plugin.json'];
const SKIPPED = new Set(['node_modules', '.DS_Store']);
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

/**
 * Versions written into new canvases. A test keeps them in step with the kit's
 * own workspace catalog.
 */
export const VERSIONS = {
  '@playwright/test': '^1.60.0',
  '@types/node': '^24.13.3',
  '@types/react': '^19.2.18',
  '@types/react-dom': '^19.2.7',
  react: '^19.2.8',
  'react-dom': '^19.2.8',
  typescript: '~6.0.2',
  vite: '^8.3.0',
  vitest: '^5.0.5',
};

export class CliError extends Error {}

const exists = path => access(path).then(() => true, () => false);
const directories = async path =>
  (await exists(path))
    ? (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    : [];

export async function kitVersion() {
  return JSON.parse(await readFile(join(kitRoot, 'package.json'), 'utf8')).version;
}

/** Written into the npm package at release: the commit it was built from. */
const RELEASE_FILE = 'cli/release.json';

/**
 * The reference new marketplaces use for the kit's reusable workflow: the exact
 * commit this package was released from, with its version as a comment, so a
 * later change to the kit repository never runs in your publish workflow until
 * you update the pin. Unreleased builds use the version tag.
 */
export async function workflowRef() {
  const version = await kitVersion();
  try {
    const { commit } = JSON.parse(await readFile(join(kitRoot, RELEASE_FILE), 'utf8'));
    if (/^[0-9a-f]{40}$/.test(commit)) return `${commit} # v${version}`;
  } catch {
    // Not a released package.
  }
  return `v${version}`;
}

/**
 * Actions the scaffolded workflows use, pinned to the commits this repository's
 * actions.lock records. Running `gh actions-lock` in a new marketplace moves the
 * pins into its own lockfile; Dependabot keeps them current either way.
 */
export const ACTIONS = {
  checkout: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  setupNode: 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0',
  pnpm: 'pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0',
};

/** The gh-actions-lock release the scaffolded check verifies lockfiles with: immutable and attested. */
export const GH_ACTIONS_LOCK = 'v0.4.0';

// ---------- configuration ----------

/** Read and validate `marketplace.config.json`, filling in defaults. */
export async function loadConfig(dir) {
  const file = join(dir, CONFIG_FILE);
  if (!(await exists(file))) throw new CliError(`${file} not found; run \`canvas-kit init\` or create it`);
  const raw = JSON.parse(await readFile(file, 'utf8'));
  for (const field of ['name', 'repository']) {
    if (typeof raw[field] !== 'string' || !raw[field]) throw new CliError(`${CONFIG_FILE} needs a "${field}"`);
  }
  if (typeof raw.owner?.name !== 'string' || !raw.owner.name) throw new CliError(`${CONFIG_FILE} needs "owner": { "name": "…" }`);
  if (!REPOSITORY.test(raw.repository)) throw new CliError(`${CONFIG_FILE} "repository" must be owner/name`);
  return {
    publishBranch: 'stable',
    sourceBranch: 'main',
    pluginsDir: 'plugins',
    canvasesDir: 'canvases',
    outDir: 'dist/marketplace',
    checkScript: 'check',
    ...raw,
  };
}

// ---------- canvases ----------

const escapers = {
  '.json': value => JSON.stringify(value).slice(1, -1),
  '.ts': value => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
  '.tsx': value => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
  '.html': value => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`),
  '.md': value => value,
  '.css': value => value,
};

/** Fill the empty dependency ranges of a template package.json. */
async function fillVersions(pkg, { catalog, kitRange }) {
  for (const field of ['dependencies', 'devDependencies']) {
    for (const dependency of Object.keys(pkg[field] ?? {})) {
      if (pkg[field][dependency]) continue;
      if (dependency === '@rwoll/canvas-kit') pkg[field][dependency] = kitRange ?? (catalog ? 'catalog:' : `^${await kitVersion()}`);
      else if (catalog) pkg[field][dependency] = 'catalog:';
      else if (VERSIONS[dependency]) pkg[field][dependency] = VERSIONS[dependency];
      else throw new CliError(`no version for template dependency ${dependency}`);
    }
  }
  return pkg;
}

/** Copy a template folder, replacing placeholders and filling package.json ranges. */
async function writeTemplate(from, target, replacements, versions) {
  for (const source of await templateFiles(from)) {
    const escape = escapers[extname(source)];
    if (!escape) throw new CliError(`no escaping rule for template file ${relative(from, source)}`);
    let content = await readFile(source, 'utf8');
    for (const [placeholder, value] of Object.entries(replacements)) content = content.replaceAll(placeholder, escape(value));
    if (relative(from, source) === 'package.json') content = `${JSON.stringify(await fillVersions(JSON.parse(content), versions), null, 2)}\n`;
    const destination = join(target, relative(from, source));
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, content);
  }
}

/** Replace text that a template is known to contain, failing loudly if it changed. */
async function patch(file, from, to) {
  const content = await readFile(file, 'utf8');
  if (!content.includes(from)) throw new CliError(`${file} no longer contains the text canvas-kit expected; update it by hand`);
  await writeFile(file, content.replace(from, to));
}

/**
 * Create the marketplace's shared UI package: React components and a theme that
 * every canvas imports, so canvases look the same and branding changes in one place.
 */
export async function createUiPackage(marketplaceDir, uiName, options = {}) {
  if (!/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(uiName)) throw new CliError(`"${uiName}" is not a valid package name`);
  const target = join(marketplaceDir, options.folder ?? 'ui');
  if (await exists(target)) throw new CliError(`${relative(marketplaceDir, target) || target} already exists`);
  await writeTemplate(uiTemplateDir, target, { __UI_NAME__: uiName }, { catalog: options.dependencies === 'catalog' });
  return { dir: target, name: uiName };
}

/**
 * Add a shared UI package to an existing marketplace: create it, record it as
 * `ui` in marketplace.config.json, and add it to pnpm-workspace.yaml.
 */
export async function addUiPackage(marketplaceDir, uiName, options = {}) {
  const config = await loadConfig(marketplaceDir);
  if (config.ui) throw new CliError(`${CONFIG_FILE} already names a shared UI package, ${config.ui}`);
  const folder = options.folder ?? 'ui';
  const ui = await createUiPackage(marketplaceDir, uiName, { ...options, folder });
  const configFile = join(marketplaceDir, CONFIG_FILE);
  await writeFile(configFile, `${JSON.stringify({ ...JSON.parse(await readFile(configFile, 'utf8')), ui: uiName }, null, 2)}\n`);
  const workspace = join(marketplaceDir, 'pnpm-workspace.yaml');
  let workspaceUpdated = false;
  if (await exists(workspace)) {
    const yaml = await readFile(workspace, 'utf8');
    if (/^packages:\s*$/m.test(yaml) && !new RegExp(`^\\s*-\\s*['"]?${folder}['"]?\\s*$`, 'm').test(yaml)) {
      await writeFile(workspace, yaml.replace(/^packages:\s*$/m, `packages:\n  - ${folder}`));
      workspaceUpdated = true;
    }
  }
  return { ...ui, workspaceUpdated };
}

async function templateFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await templateFiles(path)));
    else files.push(path);
  }
  return files;
}

/**
 * Create a canvas package from the template under the marketplace's canvases folder.
 * `dependencies: 'catalog'` writes `catalog:` ranges, for pnpm workspaces with a catalog.
 */
export async function newCanvas(marketplaceDir, name, options = {}) {
  if (!KEBAB.test(name)) throw new CliError(`"${name}" must be kebab-case, for example release-board`);
  const config = (await exists(join(marketplaceDir, CONFIG_FILE))) ? await loadConfig(marketplaceDir) : undefined;
  const canvasesDir = join(marketplaceDir, config?.canvasesDir ?? 'canvases');
  const id = options.id ?? (options.idPrefix ? `${options.idPrefix}-${name}` : name);
  if (!KEBAB.test(id)) throw new CliError(`canvas id "${id}" must be kebab-case`);
  const title = (options.title ?? name.replace(/-/g, ' ').replace(/^./, char => char.toUpperCase())).trim();
  const description = (options.description ?? `Show the ${title} canvas.`).trim();
  if (!title || !description) throw new CliError('title and description must not be empty');
  if (/[\r\n]/.test(title + description)) throw new CliError('title and description must be a single line');

  const target = join(canvasesDir, name);
  if (await exists(target)) throw new CliError(`${relative(marketplaceDir, target) || target} already exists`);
  if (config && (await exists(join(marketplaceDir, config.pluginsDir, name)))) {
    throw new CliError(`${config.pluginsDir}/${name} already exists; plugin names must be unique`);
  }

  const replacements = { __NAME__: name, __CANVAS_ID__: id, __TITLE__: title, __DESCRIPTION__: description };
  await writeTemplate(templateDir, target, replacements, { catalog: options.dependencies === 'catalog', kitRange: options.kitRange });

  // Use the marketplace's shared components and theme, so every canvas looks the same.
  const ui = options.ui === undefined ? config?.ui : options.ui;
  if (ui) {
    const pkgFile = join(target, 'package.json');
    const pkg = JSON.parse(await readFile(pkgFile, 'utf8'));
    pkg.dependencies = Object.fromEntries(Object.entries({ ...pkg.dependencies, [ui]: 'workspace:*' }).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
    await patch(join(target, 'src', 'main.tsx'), "import '@rwoll/canvas-kit/styles.css'\n", `import '@rwoll/canvas-kit/styles.css'\nimport '${ui}/theme.css'\n`);
    const app = join(target, 'src', 'App.tsx');
    await patch(app, "import type canvas from '../server/canvas.ts'\n", `import { Header } from '${ui}'\nimport type canvas from '../server/canvas.ts'\n`);
    await patch(app, '<h1>{TITLE}</h1>', '<Header title={TITLE} />');
  }
  return { dir: target, name, id, title, ...(ui && { ui }) };
}

// ---------- marketplaces ----------

/** Create a marketplace repository: config, workspace, publish workflow, and optionally a first canvas. */
export async function initMarketplace(dir, options) {
  const { name, owner, repository } = options;
  if (!KEBAB.test(name)) throw new CliError(`marketplace name "${name}" must be kebab-case`);
  if (!owner) throw new CliError('owner is required');
  if (!REPOSITORY.test(repository)) throw new CliError('repository must be owner/name');
  if ((await exists(dir)) && (await readdir(dir)).length > 0) throw new CliError(`${dir} is not empty`);
  const version = await kitVersion();
  const ref = await workflowRef();
  const uiName = `@${name}/ui`;
  for (const folder of ['plugins', 'canvases', join('.github', 'workflows')]) await mkdir(join(dir, folder), { recursive: true });

  const files = {
    [CONFIG_FILE]: { name, owner: { name: owner }, repository, publishBranch: 'stable', sourceBranch: 'main', ui: uiName },
    'package.json': {
      name,
      private: true,
      type: 'module',
      packageManager: 'pnpm@11.19.0',
      engines: { node: '>=22.12.0' },
      scripts: {
        'new-canvas': 'canvas-kit new',
        build: 'pnpm -r --filter "./canvases/*" build && canvas-kit build',
        typecheck: 'pnpm -r typecheck',
        test: 'pnpm -r test',
        e2e: 'pnpm -r e2e',
        check: 'pnpm build && pnpm typecheck && pnpm test',
        release: 'canvas-kit release',
      },
      devDependencies: { '@rwoll/canvas-kit': `^${version}` },
    },
    'pnpm-workspace.yaml': [
      'packages:',
      '  - ui',
      '  - canvases/*',
      '',
      '# Never run dependency lifecycle scripts, and fail if a dependency needs one.',
      'ignoreScripts: true',
      'strictDepBuilds: true',
      '',
      '# Install only versions published at least 7 days ago, including transitive',
      '# dependencies, so a compromised release is usually caught before you get it.',
      '# The canvas-kit release this marketplace was created with is exempt, so it',
      '# installs right away; later versions wait like everything else.',
      'minimumReleaseAge: 10080',
      'minimumReleaseAgeIgnoreMissingTime: false',
      'minimumReleaseAgeExclude:',
      `  - '@rwoll/canvas-kit@${version}'`,
      '',
    ],
    '.gitignore': ['node_modules', 'dist', '*.local', '.DS_Store', 'test-results', 'playwright-report', ''],
    'plugins/.gitkeep': [''],
    '.github/workflows/publish.yml': [
      '# Publishes the marketplace to the stable branch on every push to main. The',
      '# build runs with a read-only token; only a small push job can write.',
      'name: Publish marketplace',
      '',
      'on:',
      '  push:',
      '    branches: [main]',
      '  workflow_dispatch:',
      '',
      'permissions: {}',
      '',
      'jobs:',
      '  publish:',
      '    permissions:',
      '      contents: write',
      `    uses: ${KIT_REPOSITORY}/.github/workflows/marketplace.yml@${ref}`,
      '    # To approve each publish, create a `stable` environment with required',
      '    # reviewers, limited to the main branch, and uncomment:',
      '    # with:',
      '    #   environment: stable',
      '',
    ],
    '.github/workflows/check.yml': [
      '# Checks pull requests with a read-only token and no secrets.',
      'name: Check',
      '',
      'on:',
      '  pull_request:',
      '',
      'permissions:',
      '  contents: read',
      '',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    timeout-minutes: 30',
      '    steps:',
      `      - uses: ${ACTIONS.checkout}`,
      '        with:',
      '          persist-credentials: false',
      `      - uses: ${ACTIONS.setupNode}`,
      '        with:',
      '          node-version: 24',
      `      - uses: ${ACTIONS.pnpm}`,
      '      - run: pnpm install --frozen-lockfile',
      '      - run: pnpm check',
      '',
      '  # Once you lock your actions with `gh actions-lock`, fail when',
      '  # .github/workflows/actions.lock is out of date or no longer verifies.',
      '  actions-lock:',
      '    runs-on: ubuntu-latest',
      '    timeout-minutes: 10',
      '    env:',
      '      GH_TOKEN: ${{ github.token }}',
      `      GH_ACTIONS_LOCK: ${GH_ACTIONS_LOCK}`,
      '    steps:',
      `      - uses: ${ACTIONS.checkout}`,
      '        with:',
      '          persist-credentials: false',
      '      - name: Verify actions.lock',
      '        run: |',
      '          if [ ! -f .github/workflows/actions.lock ]; then',
      '            echo "::notice::No actions.lock yet. Run gh actions-lock to lock your actions to reviewed commits."',
      '            exit 0',
      '          fi',
      '          gh extension install github/gh-actions-lock --pin "$GH_ACTIONS_LOCK"',
      '          gh attestation verify "${XDG_DATA_HOME:-$HOME/.local/share}/gh/extensions/gh-actions-lock/gh-actions-lock" \\',
      '            --repo github/gh-actions-lock \\',
      '            --signer-workflow github/gh-actions-lock/.github/workflows/release.yml \\',
      '            --source-ref "refs/tags/$GH_ACTIONS_LOCK"',
      '          gh actions-lock --verify',
      '',
    ],
    '.github/dependabot.yml': [
      '# Weekly, grouped updates, with the same 7-day cooldown as pnpm. This also',
      "# updates the pinned canvas-kit workflow and the actions' commit SHAs.",
      'version: 2',
      'updates:',
      '  - package-ecosystem: github-actions',
      '    directory: /',
      '    schedule:',
      '      interval: weekly',
      '    cooldown:',
      '      default-days: 7',
      '    groups:',
      '      actions:',
      "        patterns: ['*']",
      '  - package-ecosystem: npm',
      '    directory: /',
      '    schedule:',
      '      interval: weekly',
      '    cooldown:',
      '      default-days: 7',
      '    groups:',
      '      dependencies:',
      "        patterns: ['*']",
      '',
    ],
    'README.md': [
      `# ${name}`,
      '',
      `A Copilot plugin marketplace built with [canvas-kit](https://github.com/${KIT_REPOSITORY}).`,
      '',
      '```sh',
      'pnpm install',
      'pnpm new-canvas release-board        # add a canvas under canvases/',
      'pnpm --filter release-board dev      # preview it in a browser',
      'pnpm check                           # build, typecheck, and test',
      '```',
      '',
      `Shared React components and the theme live in \`ui/\` (\`${uiName}\`); every new canvas uses them.`,
      'Put content-only plugins (skills, agents, MCP servers) under `plugins/<name>/` with a',
      '`plugin.json`. Every push to `main` publishes the marketplace to the `stable` branch.',
      'Install it with:',
      '',
      '```sh',
      `copilot plugin marketplace add ${repository}#stable`,
      '```',
      '',
    ],
  };
  for (const [path, content] of Object.entries(files)) {
    const text = Array.isArray(content) ? content.join('\n') : `${JSON.stringify(content, null, 2)}\n`;
    await writeFile(join(dir, path), text);
  }
  const ui = await createUiPackage(dir, uiName);
  const canvas = options.canvas ? await newCanvas(dir, options.canvas, { idPrefix: options.idPrefix }) : undefined;
  return { dir, ui, canvas };
}

async function readManifest(pluginDir, name) {
  for (const candidate of MANIFESTS) {
    const file = join(pluginDir, candidate);
    if (!(await exists(file))) continue;
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    for (const field of ['name', 'version', 'description']) {
      if (typeof manifest[field] !== 'string' || !manifest[field]) throw new CliError(`${file} needs a "${field}"`);
    }
    if (manifest.name !== name) throw new CliError(`${file} is named "${manifest.name}" but lives in "${name}"`);
    return manifest;
  }
  throw new CliError(`plugin ${name} has no manifest (${MANIFESTS.join(', ')})`);
}

/**
 * Assemble the installable marketplace: content plugins from `plugins/`, built
 * canvases from `canvases/<name>/dist/plugin`, and a catalog from their manifests.
 */
export async function buildMarketplace(dir) {
  const config = await loadConfig(dir);
  const outDir = join(dir, config.outDir);
  const sources = new Map();
  for (const name of await directories(join(dir, config.pluginsDir))) sources.set(name, join(dir, config.pluginsDir, name));
  for (const name of await directories(join(dir, config.canvasesDir))) {
    const built = join(dir, config.canvasesDir, name, 'dist', 'plugin');
    if (!(await exists(built))) throw new CliError(`${config.canvasesDir}/${name} is not built; run its build first`);
    if (sources.has(name)) throw new CliError(`"${name}" exists in both ${config.pluginsDir}/ and ${config.canvasesDir}/`);
    sources.set(name, built);
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, '.github', 'plugin'), { recursive: true });
  const plugins = [];
  for (const [name, from] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    const target = join(outDir, 'plugins', name);
    await cp(from, target, { recursive: true, filter: source => !SKIPPED.has(source.split(/[\\/]/).at(-1)) });
    if (await exists(join(target, STAMP_FILE))) throw new CliError(`${name}/${STAMP_FILE} is written by \`canvas-kit release\`; remove it from the source`);
    const { version, description } = await readManifest(target, name);
    plugins.push({ name, description, version, source: `./plugins/${name}` });
  }

  const catalog = { name: config.name, owner: config.owner, ...(config.metadata && { metadata: config.metadata }), plugins };
  await writeFile(join(outDir, '.github', 'plugin', 'marketplace.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(
    join(outDir, 'README.md'),
    [
      `# ${config.name}`,
      '',
      'Generated plugin marketplace. Do not edit this branch by hand: change the sources on',
      `\`${config.sourceBranch}\` and run \`canvas-kit release\`.`,
      '',
      '```sh',
      `copilot plugin marketplace add ${config.repository}#${config.publishBranch}`,
      '```',
      '',
    ].join('\n'),
  );
  return { catalog, outDir };
}

// ---------- jobs ----------

/**
 * Run a canvas's due jobs for its saved documents, with no chat or agent open: every
 * job when `job` is undefined, or one job by name or ID.
 * `plugin` is a built plugin folder: a canvas package's `dist/plugin`, or an installed
 * plugin such as `~/.copilot/installed-plugins/<marketplace>/<plugin>`.
 */
export async function runJob(dir, job, options = {}) {
  const pluginDir = options.plugin
    ? resolve(dir, options.plugin)
    : (await exists(join(dir, 'dist', 'plugin', 'extensions')))
      ? join(dir, 'dist', 'plugin')
      : dir;
  const extensions = join(pluginDir, 'extensions');
  if (!(await exists(extensions))) {
    throw new CliError(`${pluginDir} is not a built plugin; build the canvas first or pass --plugin <folder>`);
  }
  const all = await directories(extensions);
  const names = [];
  for (const name of all) if (await exists(join(extensions, name, 'canvas.mjs'))) names.push(name);
  const name = options.canvas ?? (names.length === 1 ? names[0] : undefined);
  if (!name) {
    throw new CliError(
      names.length === 0
        ? `${pluginDir} has no canvas.mjs; rebuild it with the current canvas-kit`
        : `${pluginDir} has several canvases (${names.join(', ')}); pass --canvas <name>`,
    );
  }
  if (!names.includes(name)) throw new CliError(`${extensions}/${name}/canvas.mjs not found`);
  const module = await import(pathToFileURL(join(extensions, name, 'canvas.mjs')).href);
  if (typeof module.runJob !== 'function') throw new CliError(`${name}/canvas.mjs has no runJob; rebuild it with the current canvas-kit`);
  try {
    return await module.runJob(job, { key: options.key, force: options.force, dataRoot: options.dataRoot, log: options.log });
  } catch (error) {
    // The canvas bundles its own copy of the kit, so check the error's shape rather than its class.
    if (error && typeof error.code === 'string' && typeof error.message === 'string') throw new CliError(error.message);
    throw error;
  }
}

// ---------- releasing ----------

// GitHub Actions command files. The install and check commands run dependency
// code, which must not set this step's outputs, summary, or later steps' env.
const ACTIONS_FILES = ['GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', 'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_STATE'];

function shell(command, cwd, log) {
  log(`\n$ ${command}`);
  const env = { ...process.env };
  for (const name of ACTIONS_FILES) delete env[name];
  const result = spawnSync(command, { cwd, stdio: 'inherit', shell: true, env });
  if (result.status !== 0) throw new CliError(`${command} failed`);
}

async function packageManager(top) {
  if (await exists(join(top, 'pnpm-lock.yaml'))) return { install: 'pnpm install --frozen-lockfile', run: 'pnpm run' };
  if (await exists(join(top, 'package-lock.json'))) return { install: 'npm ci --ignore-scripts', run: 'npm run' };
  throw new CliError('no pnpm-lock.yaml or package-lock.json at the repository root');
}

async function scriptCommand(marketplaceDir, runner, preferred) {
  const pkg = JSON.parse(await readFile(join(marketplaceDir, 'package.json'), 'utf8').catch(() => '{}'));
  const script = pkg.scripts?.[preferred] ? preferred : 'build';
  if (!pkg.scripts?.[script]) throw new CliError(`${join(marketplaceDir, 'package.json')} needs a "${preferred}" or "build" script`);
  return `${runner} ${script}`;
}

/**
 * Publish the marketplace built from the source branch to the publish branch.
 * Builds in a clean worktree with a frozen-lockfile install, commits only when the
 * output changed, and only moves the publish branch forward. Each plugin gets a
 * `release.json` stamp with the time and source commit of the release that last changed it.
 */
export async function release(dir, options = {}) {
  const { dryRun = false, skipChecks = false, footer = [], remote = 'origin', log = console.log, bundle, githubOutput = false } = options;
  const config = await loadConfig(dir);
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).trim();
  const subdir = relative(top, resolve(dir));
  const git = (args, cwd = top) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const tryGit = (args, cwd = top) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const isAncestor = (ancestor, descendant) => tryGit(['merge-base', '--is-ancestor', ancestor, descendant]).status === 0;
  const { publishBranch, sourceBranch } = config;

  if (git(['status', '--porcelain'])) throw new CliError('commit or stash your changes first so the release matches a commit');
  git(['fetch', '--quiet', remote]);
  const sha = git(['rev-parse', 'HEAD']);
  const tip = git(['rev-parse', `${remote}/${sourceBranch}`]);
  if (sha !== tip) {
    if (process.env.GITHUB_ACTIONS && isAncestor(sha, tip)) {
      log(`${sha.slice(0, 7)} is behind ${remote}/${sourceBranch}; the run for the newer commit publishes it.`);
      return { published: false, reason: 'behind' };
    }
    throw new CliError(
      `only ${remote}/${sourceBranch} is published; check out and pull ${sourceBranch} (HEAD is ${sha.slice(0, 7)}, ${remote}/${sourceBranch} is ${tip.slice(0, 7)})`,
    );
  }
  const subject = git(['log', '-1', '--format=%s', sha]);

  const remoteExists = tryGit(['ls-remote', '--exit-code', '--heads', remote, publishBranch]).status === 0;
  if (remoteExists) {
    git(['fetch', '--quiet', remote, `${publishBranch}:refs/remotes/${remote}/${publishBranch}`]);
    const previous = git(['log', '-1', '--format=%(trailers:key=Source-Commit,valueonly)', `${remote}/${publishBranch}`]);
    if (previous && !isAncestor(previous, sha)) {
      throw new CliError(
        `${publishBranch} was built from ${previous.slice(0, 7)}, which is not an ancestor of ${sha.slice(0, 7)}; refusing to publish an older or unrelated source`,
      );
    }
  }

  const source = await mkdtemp(join(tmpdir(), 'canvas-kit-source-'));
  const output = await mkdtemp(join(tmpdir(), 'canvas-kit-publish-'));
  const tempBranch = `canvas-kit-publish-${process.pid}`;
  try {
    // Build from a clean checkout so ignored or stale local files can never be published.
    git(['worktree', 'add', '--quiet', '--detach', source, sha]);
    const marketplace = join(source, subdir);
    const manager = () => packageManager(source);
    shell(config.installCommand ?? (await manager()).install, source, log);
    const build = skipChecks
      ? config.buildCommand ?? (await scriptCommand(marketplace, (await manager()).run, 'build'))
      : config.checkCommand ?? (await scriptCommand(marketplace, (await manager()).run, config.checkScript));
    shell(build, marketplace, log);

    if (remoteExists) {
      git(['worktree', 'add', '--quiet', '--detach', output, `${remote}/${publishBranch}`]);
    } else {
      git(['worktree', 'add', '--quiet', '--detach', output, sha]);
      git(['switch', '--quiet', '--orphan', tempBranch], output);
    }
    for (const entry of await readdir(output)) {
      if (entry !== '.git') await rm(join(output, entry), { recursive: true, force: true });
    }
    await cp(join(marketplace, config.outDir), output, { recursive: true });
    git(['add', '--all'], output);
    await stampPlugins(output, sha, git, tryGit);

    if (tryGit(['diff', '--cached', '--quiet'], output).status === 0) {
      log(`\n${publishBranch} already matches ${sha.slice(0, 7)}; nothing to publish.`);
      return { published: false, reason: 'unchanged' };
    }
    const stat = git(['diff', '--cached', '--stat'], output);
    log(`\nChanges for ${publishBranch}:\n${stat}`);
    // Git reads trailers only from the last paragraph, so trailer-style footers join Source-Commit.
    const isTrailer = text => /^[A-Za-z][\w-]*: \S/.test(text);
    const message = [
      `Publish ${sha.slice(0, 7)}: ${subject}`,
      `Built from https://github.com/${config.repository}/commit/${sha}`,
      ...footer.filter(text => !isTrailer(text)),
      [...footer.filter(isTrailer), `Source-Commit: ${sha}`].join('\n'),
    ].join('\n\n');
    if (dryRun) {
      log(`\nDry run: would commit and push to ${publishBranch}:\n\n${message}`);
      return { published: false, reason: 'dry-run', message };
    }
    const commit = spawnSync('git', ['commit', '--quiet', '--file', '-'], { cwd: output, input: message, stdio: ['pipe', 'inherit', 'inherit'] });
    if (commit.status !== 0) throw new CliError('git commit failed');
    if (bundle) {
      const base = remoteExists ? `${remote}/${publishBranch}` : undefined;
      return await writeBundle({ output, file: resolve(bundle), base, branch: publishBranch, sha, stat, git, tryGit, log, githubOutput });
    }
    git(['push', '--quiet', remote, `HEAD:refs/heads/${publishBranch}`], output);
    const published = git(['rev-parse', 'HEAD'], output);
    log(`\nPublished ${published.slice(0, 7)} to ${publishBranch}.`);
    log(`Update installs with:\n  copilot plugin marketplace update ${config.name}\n  copilot plugin update --all`);
    return { published: true, commit: published };
  } finally {
    for (const worktree of [source, output]) {
      tryGit(['worktree', 'remove', '--force', worktree]);
      await rm(worktree, { recursive: true, force: true });
    }
    if (!remoteExists) tryGit(['branch', '-D', tempBranch]);
  }
}

/**
 * Save the prepared publish commit as a git bundle instead of pushing it, so a
 * separate job that holds the write token can push it without running the build.
 * With `githubOutput`, also writes the step outputs and summary the reusable
 * workflow's push job reads.
 */
async function writeBundle({ output, file, base, branch, sha, stat, git, tryGit, log, githubOutput }) {
  await mkdir(dirname(file), { recursive: true });
  const created = tryGit(['bundle', 'create', file, 'HEAD', ...(base ? [`^refs/remotes/${base}`] : [])], output);
  if (created.status !== 0) throw new CliError(`git bundle failed: ${created.stderr}`);
  const commit = git(['rev-parse', 'HEAD'], output);
  log(`\nPrepared ${commit.slice(0, 7)} for ${branch} in ${file}.`);
  if (githubOutput && process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `commit=${commit}\nbranch=${branch}\n`);
  if (githubOutput && process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### Ready to publish to \`${branch}\`\n\nBuilt from ${sha}. The push job publishes this commit once its environment allows it.\n\n\`\`\`text\n${stat}\n\`\`\`\n`,
    );
  }
  return { published: false, reason: 'bundled', commit, branch, bundle: file };
}

// Restamp plugins whose content changed since the last release; restore the
// previous stamp for the rest so an unchanged snapshot produces no commit.
async function stampPlugins(output, sourceCommit, git, tryGit) {
  const hasHead = tryGit(['rev-parse', '--verify', '--quiet', 'HEAD'], output).status === 0;
  const changed = hasHead ? git(['diff', '--cached', '--name-only', 'HEAD'], output).split('\n').filter(Boolean) : [];
  const catalog = JSON.parse(await readFile(join(output, '.github', 'plugin', 'marketplace.json'), 'utf8'));
  const publishedAt = new Date().toISOString();
  for (const { name, version } of catalog.plugins) {
    const stamp = `plugins/${name}/${STAMP_FILE}`;
    const contentChanged = !hasHead || changed.some(path => path.startsWith(`plugins/${name}/`) && path !== stamp);
    const hadStamp = hasHead && tryGit(['cat-file', '-e', `HEAD:${stamp}`], output).status === 0;
    if (contentChanged || !hadStamp) {
      await writeFile(join(output, stamp), `${JSON.stringify({ name, version, publishedAt, sourceCommit }, null, 2)}\n`);
    } else {
      git(['checkout', 'HEAD', '--', stamp], output);
    }
  }
  git(['add', '--all'], output);
}
