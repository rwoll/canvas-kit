import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTIONS, CliError, GH_ACTIONS_LOCK, VERSIONS, addUiPackage, buildMarketplace, initMarketplace, kitVersion, newCanvas, release, runJob } from './lib.mjs';

const workspace = fileURLToPath(new URL('../../../pnpm-workspace.yaml', import.meta.url));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canvas-kit-cli-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const config = { name: 'demo', owner: { name: 'octo' }, repository: 'octo/demo' };

describe('canvas-kit new', () => {
  it('writes a canvas with published ranges or catalog ranges', async () => {
    const canvas = await newCanvas(dir, 'release-board', { title: "Octo's board", idPrefix: 'octo' });
    expect(canvas).toMatchObject({ id: 'octo-release-board', title: "Octo's board" });
    const pkg = await json(join(dir, 'canvases', 'release-board', 'package.json'));
    expect(pkg.name).toBe('release-board');
    expect(pkg.dependencies['@rwoll/canvas-kit']).toBe(`^${await kitVersion()}`);
    expect(pkg.devDependencies['@playwright/test']).toBe(VERSIONS['@playwright/test']);
    const source = await readFile(join(dir, 'canvases', 'release-board', 'server', 'canvas.ts'), 'utf8');
    expect(source).toContain("id: 'octo-release-board'");
    expect(source).toContain("title: 'Octo\\'s board'");

    await newCanvas(dir, 'notes', { dependencies: 'catalog', kitRange: 'workspace:*' });
    const catalog = await json(join(dir, 'canvases', 'notes', 'package.json'));
    expect(catalog.dependencies).toEqual({ '@rwoll/canvas-kit': 'workspace:*', react: 'catalog:', 'react-dom': 'catalog:' });

    await expect(newCanvas(dir, 'notes')).rejects.toThrow(/already exists/);
    await expect(newCanvas(dir, 'Bad_Name')).rejects.toBeInstanceOf(CliError);
  });

  it('wires new canvases to the marketplace\'s shared UI package', async () => {
    await writeFile(join(dir, 'marketplace.config.json'), JSON.stringify(config));
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - canvases/*\n');
    const ui = await addUiPackage(dir, '@octo/ui');
    expect(ui).toMatchObject({ name: '@octo/ui', workspaceUpdated: true });
    expect(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe('packages:\n  - ui\n  - canvases/*\n');
    expect((await json(join(dir, 'marketplace.config.json'))).ui).toBe('@octo/ui');
    const uiPkg = await json(join(dir, 'ui', 'package.json'));
    expect(uiPkg).toMatchObject({ name: '@octo/ui', private: true, exports: { '.': './src/index.ts', './theme.css': './theme.css' } });
    expect(uiPkg.devDependencies.react).toBe(VERSIONS.react);
    await expect(addUiPackage(dir, '@octo/other')).rejects.toThrow(/already names/);

    const canvas = await newCanvas(dir, 'board');
    expect(canvas.ui).toBe('@octo/ui');
    expect((await json(join(dir, 'canvases', 'board', 'package.json'))).dependencies['@octo/ui']).toBe('workspace:*');
    expect(await readFile(join(dir, 'canvases', 'board', 'src', 'main.tsx'), 'utf8')).toContain("import '@octo/ui/theme.css'\n");
    const app = await readFile(join(dir, 'canvases', 'board', 'src', 'App.tsx'), 'utf8');
    expect(app).toContain("import { Header } from '@octo/ui'");
    expect(app).toContain('<Header title={TITLE} />');

    // A canvas can opt out.
    await newCanvas(dir, 'plain', { ui: null });
    expect((await json(join(dir, 'canvases', 'plain', 'package.json'))).dependencies['@octo/ui']).toBeUndefined();
  });

  it('keeps template versions in step with the workspace catalog', async () => {
    const yaml = await readFile(workspace, 'utf8');
    for (const [name, range] of Object.entries(VERSIONS)) {
      expect(yaml, name).toContain(`${name.startsWith('@') ? `'${name}'` : name}: ${range}`);
    }
  });
});

describe('canvas-kit init and build', () => {
  it('creates a marketplace and assembles plugins and built canvases', async () => {
    const root = join(dir, 'market');
    await initMarketplace(root, { name: 'demo', owner: 'octo', repository: 'octo/demo', canvas: 'board' });
    expect(await json(join(root, 'marketplace.config.json'))).toMatchObject({ ...config, ui: '@demo/ui' });
    expect(await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8')).toContain('  - ui\n  - canvases/*');
    expect((await json(join(root, 'canvases', 'board', 'package.json'))).dependencies['@demo/ui']).toBe('workspace:*');
    const publish = await readFile(join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
    expect(publish).toContain(`/.github/workflows/marketplace.yml@v${await kitVersion()}`);
    expect(publish).not.toContain('@main');
    expect(await readFile(join(root, '.github', 'workflows', 'check.yml'), 'utf8')).toContain('contents: read');
    expect(await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8')).toMatch(/^minimumReleaseAge: 10080$/m);
    expect(await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8')).toContain('ignoreScripts: true');
    await expect(initMarketplace(root, { name: 'demo', owner: 'octo', repository: 'octo/demo' })).rejects.toThrow(/not empty/);

    await expect(buildMarketplace(root)).rejects.toThrow(/canvases\/board is not built/);
    await mkdir(join(root, 'canvases', 'board', 'dist', 'plugin', '.plugin'), { recursive: true });
    await writeFile(join(root, 'canvases', 'board', 'dist', 'plugin', '.plugin', 'plugin.json'), JSON.stringify({ name: 'board', version: '0.1.0', description: 'Board' }));
    await mkdir(join(root, 'plugins', 'skills'), { recursive: true });
    await writeFile(join(root, 'plugins', 'skills', 'plugin.json'), JSON.stringify({ name: 'skills', version: '1.0.0', description: 'Skills' }));

    const { catalog, outDir } = await buildMarketplace(root);
    expect(catalog.plugins.map(plugin => `${plugin.name}@${plugin.version}`)).toEqual(['board@0.1.0', 'skills@1.0.0']);
    expect(await json(join(outDir, '.github', 'plugin', 'marketplace.json'))).toEqual(catalog);

    await writeFile(join(root, 'plugins', 'skills', 'plugin.json'), JSON.stringify({ name: 'other', version: '1.0.0', description: 'Skills' }));
    await expect(buildMarketplace(root)).rejects.toThrow(/is named "other"/);
  });
});

describe('scaffolded workflows', () => {
  it('pin the commits this repository\'s actions.lock records, and its gh-actions-lock version', async () => {
    const workflows = new URL('../../../.github/workflows/', import.meta.url);
    const lock = await readFile(fileURLToPath(new URL('actions.lock', workflows)), 'utf8');
    for (const pinned of Object.values(ACTIONS)) {
      const [, name, sha, version] = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v[\d.]+)$/.exec(pinned) ?? [];
      expect(sha, pinned).toBeDefined();
      expect(lock).toContain(`'${name}@${version}':\n        ref: '${version}'\n        commit: 'sha1-${sha}'`);
    }
    const ci = await readFile(fileURLToPath(new URL('ci.yml', workflows)), 'utf8');
    expect(ci).toContain(`GH_ACTIONS_LOCK: ${GH_ACTIONS_LOCK}\n`);
  });
});

describe('canvas-kit run', () => {
  const stub = async (plugin, name) => {
    const folder = join(dir, plugin, 'extensions', name);
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, 'canvas.mjs'),
      `export function runJob(job, options) {
        if (job === 'missing') throw Object.assign(new Error('${name} has no job missing'), { code: 'not_found' });
        return [{ job, key: options.key ?? 'saved', ran: !!options.force, canvas: '${name}', dataRoot: options.dataRoot }];
      }`,
    );
  };

  it('loads the built canvas and runs the job', async () => {
    await stub('dist/plugin', 'board');
    expect(await runJob(dir, 'refresh', { force: true, dataRoot: '/data' })).toEqual([
      { job: 'refresh', key: 'saved', ran: true, canvas: 'board', dataRoot: '/data' },
    ]);
    await expect(runJob(dir, 'missing')).rejects.toThrow(new CliError('board has no job missing'));
  });

  it('asks which canvas when a plugin has several', async () => {
    await stub('plugin', 'a');
    await stub('plugin', 'b');
    await expect(runJob(dir, 'refresh', { plugin: 'plugin' })).rejects.toThrow(/several canvases \(a, b\); pass --canvas/);
    expect(await runJob(dir, 'refresh', { plugin: 'plugin', canvas: 'b', key: 'k' })).toMatchObject([{ canvas: 'b', key: 'k' }]);
    await expect(runJob(dir, 'refresh', { plugin: 'nowhere' })).rejects.toThrow(/is not a built plugin/);
  });
});

describe('canvas-kit release', () => {
  it('publishes to the publish branch only when the output changes, and stamps plugins', { timeout: 30_000 }, async () => {
    const remote = join(dir, 'remote.git');
    const work = join(dir, 'work');
    git(dir, 'init', '--quiet', '--bare', '-b', 'main', remote);
    git(dir, 'clone', '--quiet', remote, work);
    git(work, 'config', 'user.name', 'Test');
    git(work, 'config', 'user.email', 'test@example.com');
    git(work, 'config', 'commit.gpgsign', 'false');
    // The marketplace lives in a subfolder; install and check are plain commands so the test needs no package manager.
    const market = join(work, 'market');
    await mkdir(join(market, 'plugins', 'skills'), { recursive: true });
    await writeFile(
      join(market, 'marketplace.config.json'),
      JSON.stringify({ ...config, installCommand: 'node -e 0', checkCommand: 'node ../build.mjs' }),
    );
    await writeFile(join(market, 'plugins', 'skills', 'plugin.json'), JSON.stringify({ name: 'skills', version: '1.0.0', description: 'Skills' }));
    // Unchanged between publishes, so the bundle below leaves it out.
    await mkdir(join(market, 'plugins', 'skills', 'skills', 'hello'), { recursive: true });
    await writeFile(join(market, 'plugins', 'skills', 'skills', 'hello', 'SKILL.md'), '# Hello\n');
    await writeFile(
      join(work, 'build.mjs'),
      `import { buildMarketplace } from ${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)};\nawait buildMarketplace(process.cwd());\n`,
    );
    await writeFile(join(work, '.gitignore'), 'dist\n');
    git(work, 'add', '--all');
    git(work, 'commit', '--quiet', '-m', 'Add skills');
    git(work, 'push', '--quiet', 'origin', 'main');

    const quiet = () => {};
    expect(await release(market, { dryRun: true, log: quiet })).toMatchObject({ published: false, reason: 'dry-run' });
    const first = await release(market, { log: quiet, footer: ['Signed-off-by: Test <test@example.com>'] });
    expect(first.published).toBe(true);
    const stamp = JSON.parse(git(work, 'show', 'origin/stable:plugins/skills/release.json'));
    expect(stamp).toMatchObject({ name: 'skills', version: '1.0.0', sourceCommit: git(work, 'rev-parse', 'HEAD') });
    expect(git(work, 'log', '-1', '--format=%(trailers:key=Source-Commit,valueonly)', 'origin/stable')).toBe(stamp.sourceCommit);

    // A source change outside the marketplace output publishes nothing.
    await writeFile(join(work, 'README.md'), 'notes\n');
    git(work, 'add', '--all');
    git(work, 'commit', '--quiet', '-m', 'Docs');
    git(work, 'push', '--quiet', 'origin', 'main');
    expect(await release(market, { log: quiet })).toMatchObject({ published: false, reason: 'unchanged' });

    await writeFile(join(work, 'README.md'), 'dirty\n');
    await expect(release(market, { log: quiet })).rejects.toThrow(/commit or stash/);
    git(work, 'checkout', '--quiet', '--', 'README.md');

    // --bundle prepares the next commit without pushing; another clone verifies and pushes it.
    await writeFile(join(market, 'plugins', 'skills', 'plugin.json'), JSON.stringify({ name: 'skills', version: '1.1.0', description: 'Skills' }));
    git(work, 'commit', '--quiet', '-am', 'Skills 1.1.0');
    git(work, 'push', '--quiet', 'origin', 'main');
    const stableBefore = git(work, 'rev-parse', 'origin/stable');
    const file = join(dir, 'out', 'publish.bundle');
    // Checks run with no GitHub Actions command files, and outputs are written only on request.
    const outputs = join(dir, 'github-output');
    await writeFile(join(work, 'build.mjs'), `${await readFile(join(work, 'build.mjs'), 'utf8')}if (process.env.GITHUB_OUTPUT) throw new Error('the check sees GITHUB_OUTPUT');\n`);
    git(work, 'commit', '--quiet', '-am', 'Check the environment');
    git(work, 'push', '--quiet', 'origin', 'main');
    const previousOutput = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = outputs;
    let prepared;
    try {
      await writeFile(outputs, '');
      prepared = await release(market, { log: quiet, bundle: file, githubOutput: true });
    } finally {
      if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = previousOutput;
    }
    expect(await readFile(outputs, 'utf8')).toBe(`commit=${prepared.commit}\nbranch=stable\n`);
    expect(prepared).toMatchObject({ published: false, reason: 'bundled', branch: 'stable', bundle: file });
    expect(git(work, 'ls-remote', 'origin', 'refs/heads/stable').split('\t')[0]).toBe(stableBefore);

    // As the reusable workflow's push job does: a depth-1 checkout of main, then the publish branch's tip in full.
    const pusher = join(dir, 'pusher');
    git(dir, 'clone', '--quiet', '--depth', '1', '--branch', 'main', pathToFileURL(remote).href, pusher);
    git(pusher, 'fetch', '--quiet', '--depth=1', 'origin', '+refs/heads/stable:refs/remotes/origin/stable');
    git(pusher, 'bundle', 'verify', '--quiet', file);
    git(pusher, '-c', 'transfer.fsckObjects=true', 'fetch', '--quiet', file, 'HEAD:refs/canvas-kit/publish');
    expect(git(pusher, 'rev-parse', 'refs/canvas-kit/publish')).toBe(prepared.commit);
    expect(git(pusher, 'rev-list', '--parents', '-n', '1', prepared.commit).split(' ').slice(1)).toEqual([stableBefore]);
    expect(git(pusher, 'log', '-1', '--format=%(trailers:key=Source-Commit,valueonly)', prepared.commit)).toBe(git(work, 'rev-parse', 'HEAD'));
    git(pusher, 'push', '--quiet', 'origin', `${prepared.commit}:refs/heads/stable`);
    expect(JSON.parse(git(work, 'show', `${prepared.commit}:plugins/skills/release.json`)).version).toBe('1.1.0');
    expect(git(work, 'show', `${prepared.commit}:plugins/skills/skills/hello/SKILL.md`)).toBe('# Hello');
  });
});
