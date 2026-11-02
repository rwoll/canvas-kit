import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTIONS, CliError, GH_ACTIONS_LOCK, VERSIONS, addUi, buildMarketplace, initMarketplace, kitVersion, newCanvas, release, runJob } from './lib.mjs';

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

describe('canvas-kit new and ui', () => {
  it('adds a canvas folder to a project', async () => {
    const canvas = await newCanvas(dir, 'release-board', { title: "Octo's board", idPrefix: 'octo' });
    expect(canvas).toMatchObject({ id: 'octo-release-board', title: "Octo's board", ui: false });
    const folder = join(dir, 'canvases', 'release-board');
    expect((await readdir(folder)).sort()).toEqual(['App.css', 'App.tsx', 'canvas.spec.ts', 'canvas.test.ts', 'canvas.ts']);
    const source = await readFile(join(folder, 'canvas.ts'), 'utf8');
    expect(source).toContain("id: 'octo-release-board'");
    expect(source).toContain("title: 'Octo\\'s board'");
    expect(await readFile(join(folder, 'App.tsx'), 'utf8')).toContain("import type canvas from './canvas.ts'");

    await expect(newCanvas(dir, 'release-board')).rejects.toThrow(/already exists/);
    await expect(newCanvas(dir, 'Bad_Name')).rejects.toBeInstanceOf(CliError);
  });

  it("uses the project's shared ui/ folder", async () => {
    const ui = await addUi(dir);
    expect((await readdir(ui.dir)).sort()).toEqual(['Checklist.tsx', 'Header.tsx', 'Markdown.tsx', 'README.md', 'TextButton.tsx', 'index.ts', 'theme.css']);
    await expect(addUi(dir)).rejects.toThrow(/already exists/);

    const canvas = await newCanvas(dir, 'board');
    expect(canvas.ui).toBe(true);
    const app = await readFile(join(dir, 'canvases', 'board', 'App.tsx'), 'utf8');
    expect(app).toContain("import { Header } from '../../ui'\n");
    expect(app).toContain("import '../../ui/theme.css'\n");
    expect(app).toContain('<Header title={TITLE} />');

    // A canvas can opt out.
    await newCanvas(dir, 'plain', { ui: false });
    expect(await readFile(join(dir, 'canvases', 'plain', 'App.tsx'), 'utf8')).not.toContain('../../ui');
  });

  it('keeps template versions in step with the workspace catalog', async () => {
    const yaml = await readFile(workspace, 'utf8');
    for (const [name, range] of Object.entries(VERSIONS)) {
      expect(yaml, name).toContain(`${name.startsWith('@') ? `'${name}'` : name}: ${range}`);
    }
  });
});

describe('canvas-kit init and build', () => {
  it('creates a one-project marketplace and assembles plugins and built canvases', async () => {
    const root = join(dir, 'market');
    await initMarketplace(root, { name: 'demo', owner: 'octo', repository: 'octo/demo', canvas: 'board' });
    expect(await json(join(root, 'marketplace.config.json'))).toEqual({ ...config, publishBranch: 'stable', sourceBranch: 'main' });
    const pkg = await json(join(root, 'package.json'));
    expect(pkg).toMatchObject({ name: 'demo', version: '0.1.0', description: 'Copilot canvases from octo/demo.', scripts: { build: 'vite build && canvas-kit build' } });
    expect(pkg.dependencies['@rwoll/canvas-kit']).toBe(`^${await kitVersion()}`);
    expect(pkg.devDependencies.vite).toBe(VERSIONS.vite);
    for (const file of ['vite.config.ts', 'tsconfig.json', 'playwright.config.ts', 'ui/index.ts', 'canvases/board/canvas.ts', 'canvases/board/App.tsx']) {
      expect(await readFile(join(root, file), 'utf8'), file).not.toBe('');
    }
    expect(await readFile(join(root, 'canvases', 'board', 'App.tsx'), 'utf8')).toContain("from '../../ui'");
    const yaml = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
    expect(yaml).not.toMatch(/^packages:/m);
    expect(yaml).toMatch(/^minimumReleaseAge: 10080$/m);
    expect(yaml).toContain('ignoreScripts: true');
    const publish = await readFile(join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
    expect(publish).toContain(`/.github/workflows/marketplace.yml@v${await kitVersion()}`);
    expect(publish).not.toContain('@main');
    expect(await readFile(join(root, '.github', 'workflows', 'check.yml'), 'utf8')).toContain('contents: read');
    await expect(initMarketplace(root, { name: 'demo', owner: 'octo', repository: 'octo/demo' })).rejects.toThrow(/not empty/);

    await expect(buildMarketplace(root)).rejects.toThrow(/canvases\/ is not built/);
    // What `vite build` writes for the project.
    await mkdir(join(root, 'dist', 'plugins', 'demo', '.plugin'), { recursive: true });
    await writeFile(join(root, 'dist', 'plugins', 'demo', '.plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '0.1.0', description: 'Demo' }));
    await mkdir(join(root, 'plugins', 'mcp'), { recursive: true });
    await writeFile(join(root, 'plugins', 'mcp', 'plugin.json'), JSON.stringify({ name: 'mcp', version: '1.0.0', description: 'MCP' }));

    const { catalog, outDir } = await buildMarketplace(root);
    expect(catalog.plugins.map(plugin => `${plugin.name}@${plugin.version}`)).toEqual(['demo@0.1.0', 'mcp@1.0.0']);
    expect(await json(join(outDir, '.github', 'plugin', 'marketplace.json'))).toEqual(catalog);

    await writeFile(join(root, 'plugins', 'mcp', 'plugin.json'), JSON.stringify({ name: 'other', version: '1.0.0', description: 'MCP' }));
    await expect(buildMarketplace(root)).rejects.toThrow(/is named "other"/);
    await mkdir(join(root, 'plugins', 'demo'), { recursive: true });
    await expect(buildMarketplace(root)).rejects.toThrow(/"demo" is both in plugins\/ and built from canvases\//);
  });
});

describe('npx commands in docs, skills, templates, CLI messages, and workflows', () => {
  // Outside a project that installs it, npx downloads whatever package has the
  // name it is given, and an unscoped `canvas-kit` on npm belongs to someone else.
  const takesValue = new Set(['--registry', '--package', '-p', '--cache', '--userconfig', '--prefix']);

  it('name a scoped package', async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const files = execFileSync(
      'git',
      ['ls-files', '-z', '--', '*.md', '.github', 'packages/canvas-kit/templates', 'packages/canvas-kit/cli/*.mjs', 'packages/create-canvas/*.mjs', ':!*.test.mjs'],
      { cwd: root, encoding: 'utf8' },
    )
      .split('\0')
      .filter(Boolean);
    expect(files).toContain('packages/canvas-kit/README.md');
    const unscoped = [];
    for (const file of files) {
      // launchd lists each argument as its own <string>.
      const text = (await readFile(join(root, file), 'utf8')).replaceAll('</string><string>', ' ');
      for (const match of text.matchAll(/\bnpx((?:[ \t]+\S+)+)/g)) {
        const tokens = match[1].trim().split(/[ \t]+/);
        let spec;
        for (let i = 0; i < tokens.length && spec === undefined; i += 1) {
          if (!tokens[i].startsWith('-')) spec = tokens[i];
          else if (takesValue.has(tokens[i])) i += 1;
        }
        if (!/^@[\w.-]+\/[\w.-]/.test(spec ?? '')) unscoped.push(`${file}: npx${match[1].split('\n')[0]}`);
      }
    }
    expect(unscoped).toEqual([]);
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
  // A plugin's canvas.mjs, as `vite build` writes it: its canvases and a runJob that picks one.
  const plugin = async (folder, names) => {
    const extension = join(dir, folder, 'extensions', 'ext');
    await mkdir(extension, { recursive: true });
    await writeFile(
      join(extension, 'canvas.mjs'),
      `export const canvases = ${JSON.stringify(names.map(name => ({ name, canvas: { id: `octo-${name}` } })))};
      export function runJob(job, options) {
        if (job === 'missing') throw Object.assign(new Error(options.canvas + ' has no job missing'), { code: 'not_found' });
        return [{ job, key: options.key ?? 'saved', ran: !!options.force, canvas: options.canvas, dataRoot: options.dataRoot }];
      }`,
    );
  };

  it('finds the canvas in the built plugins and runs the job', async () => {
    await plugin('dist/plugins/a', ['board']);
    expect(await runJob(dir, 'refresh', { force: true, dataRoot: '/data' })).toEqual([
      { job: 'refresh', key: 'saved', ran: true, canvas: 'board', dataRoot: '/data' },
    ]);
    await expect(runJob(dir, 'missing')).rejects.toThrow(new CliError('board has no job missing'));

    await plugin('dist/plugins/b', ['notes', 'summary']);
    await expect(runJob(dir, 'refresh')).rejects.toThrow(/several canvases \(board, notes, summary\); pass --canvas/);
    expect(await runJob(dir, 'refresh', { canvas: 'octo-summary', key: 'k' })).toMatchObject([{ canvas: 'summary', key: 'k' }]);
    expect(await runJob(dir, 'refresh', { plugin: 'dist/plugins/a' })).toMatchObject([{ canvas: 'board' }]);
    await expect(runJob(dir, 'refresh', { canvas: 'nope' })).rejects.toThrow(/no canvas nope; the built canvases are board, notes, summary/);
    await expect(runJob(dir, 'refresh', { plugin: 'nowhere' })).rejects.toThrow(/is not a built plugin/);
  });

  it('runs plugins built with one canvas per plugin', async () => {
    const extension = join(dir, 'old', 'extensions', 'board');
    await mkdir(extension, { recursive: true });
    await writeFile(join(extension, 'canvas.mjs'), 'export default { id: "octo-board" };\nexport function runJob(job, options) { return [{ job, canvas: options.canvas ?? "only" }]; }');
    expect(await runJob(dir, 'refresh', { plugin: 'old', canvas: 'board' })).toEqual([{ job: 'refresh', canvas: 'only' }]);
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
