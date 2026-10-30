#!/usr/bin/env node
// Apply this repository's release protections with the GitHub CLI. Safe to rerun:
//   node scripts/protect-repo.mjs [--dry-run]
// Run it again after making the repository public: for personal accounts,
// GitHub allows required reviewers, fork pull request approval, private
// vulnerability reporting, free secret scanning, and Dependabot alerts without
// extra setup only on public repositories.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' } } });
const dryRun = values['dry-run'] ?? false;
const config = JSON.parse(await readFile(new URL('../marketplace.config.json', import.meta.url), 'utf8'));
const repo = config.repository;
const ADMIN_ROLE = 5;
// The GitHub Actions app, so only Actions can report the required `check` status.
const GITHUB_ACTIONS_APP = 15368;

function gh(args, body) {
  const result = spawnSync('gh', ['api', ...args, ...(body ? ['--input', '-'] : [])], {
    encoding: 'utf8',
    input: body ? JSON.stringify(body) : undefined,
  });
  if (result.status !== 0) throw new Error(`gh api ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout ? JSON.parse(result.stdout) : undefined;
}

function change(description, args, body) {
  console.log(`${dryRun ? 'Would' : 'Will'} ${description}`);
  if (!dryRun) gh(args, body);
}

/** Like change(), but skipped when `isSet()` says the setting is already in place. */
function ensure(description, isSet, args, body) {
  if (isSet()) console.log(`Already set: ${description}`);
  else change(description, args, body);
}

/** True when a GET succeeds: for endpoints that answer 204 when on and 404 when off. */
function exists(path) {
  return spawnSync('gh', ['api', '--silent', path], { encoding: 'utf8' }).status === 0;
}

const { visibility, owner } = gh([`repos/${repo}`]);
const isPublic = visibility === 'public';
const me = gh([`users/${owner.login}`]);
console.log(`${repo} is ${visibility}.`);

// Reviews are tuned to who can merge: GitHub doesn't let authors approve their own
// pull requests, so with one maintainer, required approvals only add bypasses.
// Rerun after adding or removing a maintainer.
const maintainers = gh([`repos/${repo}/collaborators?affiliation=all&per_page=100`]).filter(user => user.type === 'User' && user.permissions?.push);
const solo = maintainers.length <= 1;
console.log(
  solo
    ? `@${me.login} is the only maintainer: pull requests need passing checks but no approval, and only npm releases wait for approval.`
    : `${maintainers.length} maintainers: pull requests also need a code owner's approval, and stable and npm deployments wait for approval.`,
);

// ---------- environments ----------

const environments = [
  // npm trusted publishing is bound to this environment on npmjs.com. Releases are
  // rare and deliberate, so they always wait for approval.
  { name: 'npm', refs: [{ name: 'v*', type: 'tag' }], approve: true },
  // With one maintainer, merging to main is the approval.
  { name: 'stable', refs: [{ name: config.sourceBranch ?? 'main', type: 'branch' }], approve: !solo },
];
for (const { name, refs, approve } of environments) {
  change(
    `configure environment ${name}: deploy only from ${refs.map(ref => `${ref.type} ${ref.name}`).join(', ')}${isPublic ? (approve ? `, approved by @${me.login}` : ', no approval') : ''}`,
    ['--method', 'PUT', `repos/${repo}/environments/${name}`],
    {
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      ...(isPublic && { reviewers: approve ? [{ type: 'User', id: me.id }] : [], prevent_self_review: false, can_admins_bypass: false }),
    },
  );
  const existing = dryRun ? [] : gh([`repos/${repo}/environments/${name}/deployment-branch-policies`]).branch_policies;
  for (const policy of existing) {
    if (!refs.some(ref => ref.name === policy.name && ref.type === policy.type)) {
      change(`remove ${policy.type} ${policy.name} from ${name}`, ['--method', 'DELETE', `repos/${repo}/environments/${name}/deployment-branch-policies/${policy.id}`]);
    }
  }
  for (const ref of refs) {
    if (!existing.some(policy => policy.name === ref.name && policy.type === ref.type)) {
      change(`allow ${ref.type} ${ref.name} to deploy to ${name}`, ['--method', 'POST', `repos/${repo}/environments/${name}/deployment-branch-policies`], ref);
    }
  }
}
if (!isPublic) console.log('Required reviewers need a public repository on this plan; rerun after making it public.');

// ---------- rulesets ----------

const rulesets = [
  {
    name: 'Release tags',
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    // Only admins create, move, or delete release tags, which publish to npm.
    rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }],
    bypass_actors: [{ actor_id: ADMIN_ROLE, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
  },
  {
    name: 'Published branch',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: [`refs/heads/${config.publishBranch ?? 'stable'}`], exclude: [] } },
    // The publish job only fast-forwards; history that users installed never changes.
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
    bypass_actors: [],
  },
  {
    name: 'Default branch',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    // Changes land through pull requests that pass CI and, with more than one
    // maintainer, a code owner's review. Admins may bypass; workflow tokens may not,
    // so no workflow can push to main.
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: solo ? 0 : 1,
          dismiss_stale_reviews_on_push: !solo,
          require_code_owner_review: !solo,
          require_last_push_approval: !solo,
          require_extra_approval_for_unattributed_changes: !solo,
          required_review_thread_resolution: false,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [
            { context: 'check', integration_id: GITHUB_ACTIONS_APP },
            { context: 'actions-lock', integration_id: GITHUB_ACTIONS_APP },
          ],
        },
      },
    ],
    bypass_actors: [{ actor_id: ADMIN_ROLE, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
  },
];
const current = gh([`repos/${repo}/rulesets`]);
for (const ruleset of rulesets) {
  const found = current.find(entry => entry.name === ruleset.name);
  if (found) change(`update ruleset "${ruleset.name}"`, ['--method', 'PUT', `repos/${repo}/rulesets/${found.id}`], ruleset);
  else change(`create ruleset "${ruleset.name}"`, ['--method', 'POST', `repos/${repo}/rulesets`], ruleset);
}

// ---------- Actions ----------

change('keep the default workflow token read-only', ['--method', 'PUT', `repos/${repo}/actions/permissions/workflow`], {
  default_workflow_permissions: 'read',
  can_approve_pull_request_reviews: false,
});
// Workflows in .github/workflows/actions.lock satisfy SHA pinning through the lockfile.
change('allow only GitHub actions and pnpm/action-setup, pinned to full commit SHAs', ['--method', 'PUT', `repos/${repo}/actions/permissions`], {
  enabled: true,
  allowed_actions: 'selected',
  sha_pinning_required: true,
});
change('list the allowed actions', ['--method', 'PUT', `repos/${repo}/actions/permissions/selected-actions`], {
  github_owned_allowed: true,
  verified_allowed: false,
  patterns_allowed: ['pnpm/action-setup@*'],
});

// ---------- public-only settings ----------

// GitHub rejects turning some of these on when they already are (Dependabot alerts
// answer 422), so each is checked first. New public repositories often start with
// Dependabot alerts on.
if (isPublic) {
  const security = gh([`repos/${repo}`]).security_and_analysis ?? {};
  const on = name => security[name]?.status === 'enabled';
  ensure('turn on Dependabot alerts', () => exists(`repos/${repo}/vulnerability-alerts`), ['--method', 'PUT', `repos/${repo}/vulnerability-alerts`]);
  ensure(
    'turn on Dependabot security updates',
    () => gh([`repos/${repo}/automated-security-fixes`]).enabled,
    ['--method', 'PUT', `repos/${repo}/automated-security-fixes`],
  );
  ensure(
    'require approval before workflows run for every outside contributor',
    () => gh([`repos/${repo}/actions/permissions/fork-pr-contributor-approval`]).approval_policy === 'all_external_contributors',
    ['--method', 'PUT', `repos/${repo}/actions/permissions/fork-pr-contributor-approval`],
    { approval_policy: 'all_external_contributors' },
  );
  ensure(
    'turn on private vulnerability reporting',
    () => gh([`repos/${repo}/private-vulnerability-reporting`]).enabled,
    ['--method', 'PUT', `repos/${repo}/private-vulnerability-reporting`],
  );
  ensure(
    'turn on secret scanning and push protection',
    () => on('secret_scanning') && on('secret_scanning_push_protection'),
    ['--method', 'PATCH', `repos/${repo}`],
    { security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } } },
  );
} else {
  console.log(
    'Dependabot alerts (without the dependency graph), fork pull request approval, private vulnerability reporting, and free secret scanning need a public repository; rerun after making it public.',
  );
}

console.log(dryRun ? '\nDry run: nothing changed.' : '\nDone.');
