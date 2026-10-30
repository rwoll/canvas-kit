#!/usr/bin/env node
// Publish the packages to npm for a version tag. The release workflow runs:
//   node scripts/publish-npm.mjs pack v0.2.0 --out <dir>       # build job, no npm credentials
//   node scripts/publish-npm.mjs publish v0.2.0 --from <dir>   # publish job, npm trusted publishing
// In GitHub Actions, pack writes the tarballs' hashes as the step output
// `integrity`, and publish refuses tarballs whose hashes differ from
// EXPECTED_INTEGRITY, then publishes with provenance (a public repository only).
// Locally, pack and then `publish --dry-run` to check a release.
// Every package must be at the tag's version. Versions already on npm are skipped,
// so a rerun after a partial failure is safe. Packages are packed with pnpm, which
// replaces workspace: and catalog: ranges, and published with npm.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REGISTRY = 'https://registry.npmjs.org/';
const PACKAGES = { 'canvas-kit': '@rwoll/canvas-kit', 'create-canvas': '@rwoll/create-canvas' };
// Trusted publishing needs npm 11.5.1 or later.
const MIN_NPM = [11, 5, 1];
// The only publishConfig a tarball may carry. npm applies publishConfig while it
// publishes, so anything else (a proxy, TLS settings, another registry) could
// redirect the trusted publishing credential.
const PUBLISH_CONFIG = { access: 'public', registry: REGISTRY, provenance: true };
const root = fileURLToPath(new URL('..', import.meta.url));

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string' }, from: { type: 'string' }, 'dry-run': { type: 'boolean' } },
});
const [mode, tag] = positionals;
const dryRun = values['dry-run'] ?? false;

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit', cwd: options.cwd ?? root });
  if (result.status !== 0 && !options.allowFailure) throw new Error(`${command} ${args.join(' ')} failed\n${result.stderr ?? ''}`);
  return result;
}

if (!['pack', 'publish'].includes(mode)) throw new Error(`unknown mode "${mode}"; use pack or publish`);
if (!/^v\d+\.\d+\.\d+(-[\w.]+)?$/.test(tag ?? '')) throw new Error(`expected a tag like v0.2.0, got "${tag}"`);
const version = tag.slice(1);

/** The commit being released: the tagged commit in CI, or a clean local HEAD. */
function releaseCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  if (run('git', ['status', '--porcelain'], { capture: true }).stdout.trim()) throw new Error('commit your changes first');
  return run('git', ['rev-parse', 'HEAD'], { capture: true }).stdout.trim();
}

/** Pack every package at the tag's version into `out` and list what was packed. */
async function pack(out) {
  await mkdir(out, { recursive: true });
  // The CLI pins new marketplaces' workflows to the commit it was released from.
  const stamp = join(root, 'packages', 'canvas-kit', 'cli', 'release.json');
  await writeFile(stamp, `${JSON.stringify({ commit: releaseCommit(), tag }, null, 2)}\n`);
  try {
    for (const folder of Object.keys(PACKAGES)) {
      const dir = join(root, 'packages', folder);
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      if (pkg.version !== version) throw new Error(`${pkg.name} is ${pkg.version}, but the tag is ${tag}`);
      run('pnpm', ['pack', '--pack-destination', out], { cwd: dir });
    }
  } finally {
    await rm(stamp, { force: true });
  }
  await summarize(out, 'Packed');
}

/** The tarballs in `dir`, each checked to be one of our packages at the tag's version. */
async function tarballs(dir) {
  const files = (await readdir(dir)).filter(name => name.endsWith('.tgz')).sort();
  const hashes = new Map();
  for (const name of files) {
    hashes.set(name, `sha512-${createHash('sha512').update(await readFile(join(dir, name))).digest('base64')}`);
  }
  // Compare hashes before reading anything inside the tarballs.
  checkIntegrity([...hashes.values()]);
  const found = [];
  for (const name of files) {
    const file = join(dir, name);
    const entries = run('tar', ['-tzf', file], { capture: true }).stdout.split('\n').filter(Boolean);
    if (entries.filter(entry => entry === 'package/package.json').length !== 1) throw new Error(`${name} must hold exactly one package/package.json`);
    if (entries.some(entry => /(^|\/)\.npmrc$/.test(entry))) throw new Error(`${name} contains an .npmrc`);
    const manifest = JSON.parse(run('tar', ['-xzOf', file, 'package/package.json'], { capture: true }).stdout);
    const { name: pkgName, version: pkgVersion } = manifest;
    const canonical = value => JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    if (canonical(manifest.publishConfig) !== canonical(PUBLISH_CONFIG)) {
      throw new Error(`${name} has publishConfig ${JSON.stringify(manifest.publishConfig)}; only ${JSON.stringify(PUBLISH_CONFIG)} is allowed`);
    }
    if (!Object.values(PACKAGES).includes(pkgName)) throw new Error(`${name} contains ${pkgName}, which this script does not publish`);
    if (pkgVersion !== version) throw new Error(`${name} contains ${pkgName}@${pkgVersion}, but the tag is ${tag}`);
    const integrity = hashes.get(name);
    if (expectedIntegrity() && expectedIntegrity()[pkgName] !== integrity) throw new Error(`${name} does not match the build job's hash for ${pkgName}`);
    found.push({ file, name: pkgName, integrity });
  }
  const names = found.map(entry => entry.name).sort();
  const expected = Object.values(PACKAGES).sort();
  if (names.join() !== expected.join()) {
    throw new Error(`expected one tarball each for ${expected.join(', ')} in ${dir}, found ${names.join(', ') || 'none'}`);
  }
  return found;
}

async function summarize(dir, verb) {
  const found = await tarballs(dir);
  const lines = found.map(entry => `- \`${entry.name}@${version}\` \`${entry.integrity}\``);
  console.log(`${verb}:\n${lines.join('\n')}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### ${verb} for ${tag}\n\n${lines.join('\n')}\n`);
  if (process.env.GITHUB_OUTPUT) {
    const integrity = Object.fromEntries(found.map(entry => [entry.name, entry.integrity]));
    await appendFile(process.env.GITHUB_OUTPUT, `integrity=${JSON.stringify(integrity)}\n`);
  }
}

/** The build job's hashes by package name, from EXPECTED_INTEGRITY, or undefined when not set. */
function expectedIntegrity() {
  return process.env.EXPECTED_INTEGRITY ? JSON.parse(process.env.EXPECTED_INTEGRITY) : undefined;
}

/** When publishing, the tarballs must be exactly the ones the build job packed. Required in GitHub Actions. */
function checkIntegrity(hashes) {
  if (mode !== 'publish') return;
  const expected = expectedIntegrity();
  if (!expected) {
    if (process.env.GITHUB_ACTIONS) throw new Error('EXPECTED_INTEGRITY is not set; pass the build job\'s integrity output');
    return;
  }
  const want = Object.values(expected).sort().join();
  if (hashes.slice().sort().join() !== want) throw new Error(`the tarballs' hashes ${hashes.join(', ')} differ from the build job's ${want}`);
}

function checkNpmVersion() {
  const current = run('npm', ['--version'], { capture: true }).stdout.trim().split('.').map(Number);
  const newer = current.findIndex((part, index) => part !== MIN_NPM[index]);
  if (newer !== -1 && current[newer] < MIN_NPM[newer]) {
    throw new Error(`npm ${current.join('.')} cannot use trusted publishing; use npm ${MIN_NPM.join('.')} or later`);
  }
}

/** Publish the tarballs in `dir`, skipping versions already on npm. */
async function publish(dir, { provenance = false } = {}) {
  if (process.env.GITHUB_ACTIONS) checkNpmVersion();
  for (const { file, name, integrity } of await tarballs(dir)) {
    const published = run('npm', ['view', `${name}@${version}`, 'version', '--registry', REGISTRY], { capture: true, allowFailure: true });
    if (published.status === 0 && published.stdout.trim() === version) {
      console.log(`${name}@${version} is already on npm; skipping.`);
      continue;
    }
    console.log(`Publishing ${name}@${version} (${integrity})`);
    const tagArgs = version.includes('-') ? ['--tag', 'next'] : [];
    const provenanceArgs = provenance ? ['--provenance'] : [];
    run('npm', ['publish', file, '--access', 'public', '--ignore-scripts', '--registry', REGISTRY, ...provenanceArgs, ...tagArgs, ...(dryRun ? ['--dry-run'] : [])]);
  }
}

if (mode === 'pack') {
  if (!values.out) throw new Error('pack needs --out <dir>');
  await pack(resolve(values.out));
} else {
  if (!values.from) throw new Error('publish needs --from <dir>');
  await publish(resolve(values.from), { provenance: Boolean(process.env.GITHUB_ACTIONS) });
}
