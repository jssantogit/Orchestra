import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectCanonicalCutoverReadinessFragment,
  collectCutoverReadinessFragment,
  mergeCanonicalCutoverReadinessEvidence,
} from '../../v2/cutover/readiness-evidence.mjs';

const RUNTIME_IMAGE = `sha256:${'b'.repeat(64)}`;
const PROBE_MODULE_PATH = 'v2/cutover/readiness-probes.mjs';
const OTHER_PROBE_MODULE_PATH = 'other-probe.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function probeModuleSource({ manifest = true } = {}) {
  return [
    manifest ? `export const readinessProbeManifest = Object.freeze({\n  schema: 'orchestra.cutover-readiness-probe-module.v2',\n  version: 1,\n  probes: Object.freeze({ registryPersistence: 'registryPersistence' }),\n});` : '',
    `export async function registryPersistence({ expectedHeadSha, expectedRuntimeImageId, args }) {\n  return {\n    ok: true,\n    headSha: args?.headSha ?? expectedHeadSha,\n    runtimeImageId: args?.runtimeImageId ?? expectedRuntimeImageId,\n    facts: args?.facts ?? { restartVerified: true },\n    evidenceRefs: args?.evidenceRefs ?? ['sha256:${'1'.repeat(64)}'],\n  };\n}`,
  ].filter(Boolean).join('\n\n');
}

function makeProbeRepo(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-readiness-probe-repo-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'orchestra-tests@example.invalid');
  git(root, 'config', 'user.name', 'Orchestra Tests');
  mkdirSync(join(root, 'v2/cutover'), { recursive: true });
  writeFileSync(join(root, PROBE_MODULE_PATH), probeModuleSource(options), 'utf8');
  writeFileSync(join(root, OTHER_PROBE_MODULE_PATH), probeModuleSource(options), 'utf8');
  git(root, 'add', PROBE_MODULE_PATH, OTHER_PROBE_MODULE_PATH);
  git(root, 'commit', '-m', 'test: canonical readiness probe');
  return { root, headSha: git(root, 'rev-parse', 'HEAD') };
}

function makeDependencyProbeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-readiness-probe-dependency-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 'orchestra-tests@example.invalid');
  git(root, 'config', 'user.name', 'Orchestra Tests');
  mkdirSync(join(root, 'v2/cutover'), { recursive: true });
  writeFileSync(join(root, 'probe.mjs'), `export const restartVerified = true;\n`, 'utf8');
  writeFileSync(join(root, PROBE_MODULE_PATH), [
    `import { restartVerified } from '../../probe.mjs';`,
    `export const readinessProbeManifest = Object.freeze({`,
    `  schema: 'orchestra.cutover-readiness-probe-module.v2',`,
    `  version: 1,`,
    `  probes: Object.freeze({ registryPersistence: 'registryPersistence' }),`,
    `});`,
    `export async function registryPersistence({ expectedHeadSha, expectedRuntimeImageId }) {`,
    `  return {`,
    `    ok: restartVerified,`,
    `    headSha: expectedHeadSha,`,
    `    runtimeImageId: expectedRuntimeImageId,`,
    `    facts: { restartVerified },`,
    `    evidenceRefs: ['sha256:${'3'.repeat(64)}'],`,
    `  };`,
    `}`,
  ].join('\n'), 'utf8');
  git(root, 'add', 'probe.mjs', PROBE_MODULE_PATH);
  git(root, 'commit', '-m', 'test: readiness probe dependency');
  return { root, headSha: git(root, 'rev-parse', 'HEAD') };
}

function descriptor(args = {}) {
  return {
    modulePath: PROBE_MODULE_PATH,
    args,
  };
}

test('canonical collector executes only a tracked clean probe module at the exact candidate head', async () => {
  const fixture = makeProbeRepo();
  try {
    const fragment = await collectCanonicalCutoverReadinessFragment({
      repoRoot: fixture.root,
      expectedHeadSha: fixture.headSha,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      probes: {
        registryPersistence: descriptor({ facts: { restartVerified: true } }),
      },
    });

    assert.equal(fragment.collectionMode, 'CANONICAL_GIT_PROBES');
    assert.equal(fragment.evidence.registryPersistence.status, 'VERIFIED');
    assert.equal(fragment.evidence.registryPersistence.headSha, fixture.headSha);
    assert.deepEqual(fragment.errors, []);
    assert.equal(fragment.probeSources.registryPersistence.modulePath, PROBE_MODULE_PATH);
    assert.match(fragment.probeSources.registryPersistence.sourceDigest, /^sha256:[0-9a-f]{64}$/);

    const merged = await mergeCanonicalCutoverReadinessEvidence({
      repoRoot: fixture.root,
      expectedHeadSha: fixture.headSha,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      fragments: [fragment],
      providerFieldEvidence: {},
    });
    assert.deepEqual(merged.errors, []);
    assert.equal(merged.evidence.registryPersistence.status, 'VERIFIED');

    const missingRoot = await mergeCanonicalCutoverReadinessEvidence({
      expectedHeadSha: fixture.headSha,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      fragments: [fragment],
      providerFieldEvidence: {},
    });
    assert.equal(missingRoot.evidence.registryPersistence, undefined);
    assert.ok(missingRoot.errors.includes('repoRoot'));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('canonical collector rejects arbitrary callbacks and prebuilt records as probe descriptors', async () => {
  const fixture = makeProbeRepo();
  try {
    const fragment = await collectCanonicalCutoverReadinessFragment({
      repoRoot: fixture.root,
      expectedHeadSha: fixture.headSha,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      probes: {
        registryPersistence: async () => ({ ok: true }),
        experiencePrivacy: { ok: true, status: 'VERIFIED' },
      },
    });

    assert.equal(fragment.evidence.registryPersistence, undefined);
    assert.equal(fragment.evidence.experiencePrivacy, undefined);
    assert.ok(fragment.errors.includes('registryPersistence:probe-descriptor'));
    assert.ok(fragment.errors.includes('experiencePrivacy:probe-descriptor'));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('canonical collector fails closed when the source-controlled probe module is dirty', async () => {
  const fixture = makeProbeRepo();
  try {
    const probePath = join(fixture.root, PROBE_MODULE_PATH);
    writeFileSync(probePath, `${readFileSync(probePath, 'utf8')}\n// dirty\n`, 'utf8');
    const fragment = await collectCanonicalCutoverReadinessFragment({
      repoRoot: fixture.root,
      expectedHeadSha: fixture.headSha,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      probes: { registryPersistence: descriptor() },
    });

    assert.equal(fragment.evidence.registryPersistence, undefined);
    assert.ok(fragment.errors.includes('registryPersistence:source-bytes'));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('canonical collector fails closed when a tracked imported probe dependency is dirty', async () => {
  const fixture = makeDependencyProbeRepo();
  try {
    writeFileSync(join(fixture.root, 'probe.mjs'), `export const restartVerified = false;\n`, 'utf8');
    const fragment = await collectCanonicalCutoverReadinessFragment({
      repoRoot: fixture.root,
      expectedHeadSha: fixture.headSha,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      probes: { registryPersistence: descriptor() },
    });

    assert.equal(fragment.evidence.registryPersistence, undefined);
    assert.ok(fragment.errors.includes('registryPersistence:source-repo-dirty'));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('canonical collector rejects a probe module that is not registered for the requested readiness family', async () => {
  const fixture = makeProbeRepo({ manifest: false });
  try {
    const fragment = await collectCanonicalCutoverReadinessFragment({
      repoRoot: fixture.root,
      expectedHeadSha: fixture.headSha,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      probes: { registryPersistence: descriptor() },
    });

    assert.equal(fragment.evidence.registryPersistence, undefined);
    assert.ok(fragment.errors.includes('registryPersistence:probe-manifest'));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('canonical collector rejects a tracked probe module outside the reviewed readiness path', async () => {
  const fixture = makeProbeRepo();
  try {
    const fragment = await collectCanonicalCutoverReadinessFragment({
      repoRoot: fixture.root,
      expectedHeadSha: fixture.headSha,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      probes: {
        registryPersistence: { modulePath: OTHER_PROBE_MODULE_PATH },
      },
    });

    assert.equal(fragment.evidence.registryPersistence, undefined);
    assert.ok(fragment.errors.includes('registryPersistence:probe-descriptor'));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('canonical collector rejects a tracked probe path that resolves through a symlink', async (t) => {
  const fixture = makeProbeRepo();
  const outsidePath = join(tmpdir(), `orchestra-readiness-external-probe-${Date.now()}.mjs`);
  const canonicalPath = join(fixture.root, PROBE_MODULE_PATH);
  try {
    writeFileSync(outsidePath, probeModuleSource(), 'utf8');
    rmSync(canonicalPath);
    try {
      symlinkSync(outsidePath, canonicalPath, 'file');
    } catch {
      t.skip('file symlink creation is unavailable on this host');
      return;
    }
    git(fixture.root, 'add', '-A');
    git(fixture.root, 'commit', '-m', 'test: tracked readiness probe symlink');
    fixture.headSha = git(fixture.root, 'rev-parse', 'HEAD');

    const fragment = await collectCanonicalCutoverReadinessFragment({
      repoRoot: fixture.root,
      expectedHeadSha: fixture.headSha,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      probes: { registryPersistence: descriptor() },
    });

    assert.equal(fragment.evidence.registryPersistence, undefined);
    assert.ok(fragment.errors.some((error) => error.startsWith('registryPersistence:')));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(outsidePath, { force: true });
  }
});

test('canonical collector rejects probe execution from a different repository head', async () => {
  const fixture = makeProbeRepo();
  try {
    const fragment = await collectCanonicalCutoverReadinessFragment({
      repoRoot: fixture.root,
      expectedHeadSha: 'f'.repeat(40),
      expectedRuntimeImageId: RUNTIME_IMAGE,
      probes: { registryPersistence: descriptor() },
    });

    assert.equal(fragment.evidence.registryPersistence, undefined);
    assert.ok(fragment.errors.includes('registryPersistence:source-head'));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('canonical merge refuses fragments produced through the unchecked composition helper', async () => {
  const fixture = makeProbeRepo();
  try {
    const unchecked = await collectCutoverReadinessFragment({
      expectedHeadSha: fixture.headSha,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      probes: {
        registryPersistence: async () => ({
          ok: true,
          headSha: fixture.headSha,
          runtimeImageId: RUNTIME_IMAGE,
          facts: { restartVerified: true },
          evidenceRefs: [`sha256:${'2'.repeat(64)}`],
        }),
      },
    });

    const merged = await mergeCanonicalCutoverReadinessEvidence({
      repoRoot: fixture.root,
      expectedHeadSha: fixture.headSha,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      fragments: [unchecked],
      providerFieldEvidence: {},
    });

    assert.equal(merged.readiness.ready, false);
    assert.ok(merged.errors.includes('fragment[0]:collectionMode'));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('canonical merge rejects unchecked records even when caller adds canonical marker fields', async () => {
  const fixture = makeProbeRepo();
  try {
    const unchecked = await collectCutoverReadinessFragment({
      expectedHeadSha: fixture.headSha,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      probes: {
        registryPersistence: async () => ({
          ok: true,
          headSha: fixture.headSha,
          runtimeImageId: RUNTIME_IMAGE,
          facts: { restartVerified: true },
          evidenceRefs: [`sha256:${'4'.repeat(64)}`],
        }),
      },
    });
    const forged = {
      ...unchecked,
      collectionMode: 'CANONICAL_GIT_PROBES',
      probeSources: {},
    };

    const merged = await mergeCanonicalCutoverReadinessEvidence({
      repoRoot: fixture.root,
      expectedHeadSha: fixture.headSha,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      fragments: [forged],
      providerFieldEvidence: {},
    });

    assert.equal(merged.evidence.registryPersistence, undefined);
    assert.ok(merged.errors.some((error) => error.startsWith('fragment[0]:')));
    assert.equal(merged.readiness.ready, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('canonical merge binds source digests to tracked manifests and verified family receipts', async () => {
  const fixture = makeProbeRepo();
  try {
    const canonical = await collectCanonicalCutoverReadinessFragment({
      repoRoot: fixture.root,
      expectedHeadSha: fixture.headSha,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      probes: { registryPersistence: descriptor() },
    });
    const invalidFragments = [
      {
        error: 'fragment[0]:registryPersistence:probe-source',
        fragment: {
        ...canonical,
        probeSources: {
          ...canonical.probeSources,
          registryPersistence: {
            ...canonical.probeSources.registryPersistence,
            sourceDigest: `sha256:${'f'.repeat(64)}`,
          },
        },
        },
      },
      {
        error: 'fragment[0]:probe-source-family',
        fragment: {
        ...canonical,
        probeSources: {
          ...canonical.probeSources,
          unregisteredFamily: canonical.probeSources.registryPersistence,
        },
        },
      },
      {
        error: 'fragment[0]:registryPersistence:probe-source',
        fragment: {
        ...canonical,
        probeSources: {
          ...canonical.probeSources,
          registryPersistence: {
            ...canonical.probeSources.registryPersistence,
            exportName: 'missingProbeExport',
          },
        },
        },
      },
      {
        error: 'fragment[0]:registryPersistence:record-receipt',
        fragment: {
        ...canonical,
        evidence: {
          ...canonical.evidence,
          registryPersistence: {
            ...canonical.evidence.registryPersistence,
            evidenceRefs: canonical.evidence.registryPersistence.evidenceRefs
              .filter((ref) => ref !== canonical.probeSources.registryPersistence.sourceDigest),
          },
        },
        evidenceRefs: canonical.evidenceRefs
          .filter((ref) => ref !== canonical.probeSources.registryPersistence.sourceDigest),
        },
      },
      {
        error: 'fragment[0]:registryPersistence:record-receipt',
        fragment: {
          ...canonical,
          evidence: {
            ...canonical.evidence,
            registryPersistence: {
              ...canonical.evidence.registryPersistence,
              facts: { restartVerified: false },
            },
          },
        },
      },
    ];

    for (const { fragment, error } of invalidFragments) {
      const merged = await mergeCanonicalCutoverReadinessEvidence({
        repoRoot: fixture.root,
        expectedHeadSha: fixture.headSha,
        expectedRuntimeImageId: RUNTIME_IMAGE,
        fragments: [fragment],
        providerFieldEvidence: {},
      });
      assert.equal(merged.evidence.registryPersistence, undefined);
      assert.equal(merged.readiness.ready, false);
      assert.ok(merged.errors.includes(error), `${error}: ${merged.errors.join(', ')}`);
    }

    writeFileSync(join(fixture.root, 'untracked.txt'), 'untracked\n', 'utf8');
    const dirtyRoot = await mergeCanonicalCutoverReadinessEvidence({
      repoRoot: fixture.root,
      expectedHeadSha: fixture.headSha,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      fragments: [canonical],
      providerFieldEvidence: {},
    });
    assert.equal(dirtyRoot.evidence.registryPersistence, undefined);
    assert.ok(dirtyRoot.errors.includes('source-repo-dirty'), dirtyRoot.errors.join(', '));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
