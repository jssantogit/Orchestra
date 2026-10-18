import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createGlobalProjectRegistry } from '../../v2/global/project-registry.mjs';
import { collectCanonicalCutoverReadinessFragment } from '../../v2/cutover/readiness-evidence.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HEAD = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const RUNTIME_IMAGE = `sha256:${'b'.repeat(64)}`;
const PROBE_MODULE = 'v2/cutover/readiness-probes.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeProject(name = 'probe-project') {
  const root = mkdtempSync(join(tmpdir(), `orchestra-readiness-${name}-`));
  writeFileSync(join(root, 'README.md'), `${name}\n`, 'utf8');
  git(root, 'init');
  git(root, 'config', 'user.email', 'orchestra-tests@example.invalid');
  git(root, 'config', 'user.name', 'Orchestra Tests');
  git(root, 'add', '.');
  git(root, 'commit', '-m', `fixture: ${name}`);
  return root;
}

async function registeredFixture() {
  const projectRoot = makeProject();
  const home = mkdtempSync(join(tmpdir(), 'orchestra-readiness-home-'));
  const registry = createGlobalProjectRegistry({ home });
  const registered = await registry.registerWorkspace({
    root: projectRoot,
    runtimeImage: RUNTIME_IMAGE,
    instructionEpoch: 3,
    trustMode: 'trusted',
  });
  assert.equal(registered.ok, true);
  registry.close();
  return { projectRoot, home, project: registered.project };
}

function descriptor(exportArgs) {
  return { modulePath: PROBE_MODULE, args: exportArgs };
}

test('source-controlled readiness probe module registers every non-provider readiness family', async () => {
  const module = await import('../../v2/cutover/readiness-probes.mjs');
  assert.deepEqual(module.readinessProbeManifest, {
    schema: 'orchestra.cutover-readiness-probe-module.v2',
    version: 1,
    probes: {
      registryPersistence: 'registryPersistence',
      runtimeLifecycle: 'runtimeLifecycle',
      reconciliation: 'reconciliation',
      experiencePrivacy: 'experiencePrivacy',
      rsiReplay: 'rsiReplay',
      migration: 'migration',
      'platforms.windows': 'windowsPlatform',
      'platforms.posix': 'posixPlatform',
      projects: 'project',
      selfHost: 'selfHost',
    },
  });
});

test('canonical registry, native-platform and Project probes derive facts from real state instead of caller facts', async () => {
  const fixture = await registeredFixture();
  try {
    const platformKey = process.platform === 'win32' ? 'windows' : 'posix';
    const fragment = await collectCanonicalCutoverReadinessFragment({
      repoRoot: REPO_ROOT,
      expectedHeadSha: HEAD,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      probes: {
        registryPersistence: descriptor({ home: fixture.home, projectId: fixture.project.projectId }),
        platforms: {
          [platformKey]: descriptor({}),
        },
        projects: [descriptor({ home: fixture.home, projectId: fixture.project.projectId })],
      },
    });

    assert.deepEqual(fragment.errors, []);
    assert.equal(fragment.evidence.registryPersistence.status, 'VERIFIED');
    assert.equal(fragment.evidence.registryPersistence.facts.restartVerified, true);
    assert.equal(fragment.evidence.platforms[platformKey].facts.nativeVerified, true);
    assert.equal(fragment.evidence.projects[0].facts.projectId, fixture.project.projectId);
    assert.equal(fragment.evidence.projects[0].facts.lineageId, fixture.project.lineageId);
    assert.equal(fragment.evidence.projects[0].facts.noFullLocalGovernanceRuntime, true);
    assert.match(fragment.evidenceRefs[0], /^sha256:[0-9a-f]{64}$/);
  } finally {
    rmSync(fixture.projectRoot, { recursive: true, force: true });
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('production probes reject caller-supplied fact-shaped fields instead of treating them as evidence', async () => {
  const fixture = await registeredFixture();
  try {
    const fragment = await collectCanonicalCutoverReadinessFragment({
      repoRoot: REPO_ROOT,
      expectedHeadSha: HEAD,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      probes: {
        registryPersistence: descriptor({
          home: fixture.home,
          projectId: fixture.project.projectId,
          facts: { restartVerified: true },
        }),
      },
    });
    assert.equal(fragment.evidence.registryPersistence, undefined);
    assert.ok(fragment.errors.includes('registryPersistence:probe-error'));
  } finally {
    rmSync(fixture.projectRoot, { recursive: true, force: true });
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('Project probe fails closed when a full local governance-runtime marker is present', async () => {
  const fixture = await registeredFixture();
  try {
    mkdirSync(join(fixture.projectRoot, '.orchestra/runtime/delegation'), { recursive: true });
    writeFileSync(join(fixture.projectRoot, '.orchestra/runtime/delegation/brain.mjs'), 'export default true;\n');
    const fragment = await collectCanonicalCutoverReadinessFragment({
      repoRoot: REPO_ROOT,
      expectedHeadSha: HEAD,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      probes: {
        projects: [descriptor({ home: fixture.home, projectId: fixture.project.projectId })],
      },
    });
    assert.equal(fragment.evidence.projects, undefined);
    assert.ok(fragment.errors.includes('projects[0]:ok'));
  } finally {
    rmSync(fixture.projectRoot, { recursive: true, force: true });
    rmSync(fixture.home, { recursive: true, force: true });
  }
});
