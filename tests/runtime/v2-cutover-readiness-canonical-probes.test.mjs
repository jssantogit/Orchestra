import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectCanonicalCutoverReadinessFragment,
  collectCutoverReadinessFragment,
  mergeCanonicalCutoverReadinessEvidence,
} from '../../v2/cutover/readiness-evidence.mjs';

const RUNTIME_IMAGE = `sha256:${'b'.repeat(64)}`;

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
  writeFileSync(join(root, 'probe.mjs'), probeModuleSource(options), 'utf8');
  git(root, 'add', 'probe.mjs');
  git(root, 'commit', '-m', 'test: canonical readiness probe');
  return { root, headSha: git(root, 'rev-parse', 'HEAD') };
}

function descriptor(args = {}) {
  return {
    modulePath: 'probe.mjs',
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
    assert.equal(fragment.probeSources.registryPersistence.modulePath, 'probe.mjs');
    assert.match(fragment.probeSources.registryPersistence.sourceDigest, /^sha256:[0-9a-f]{64}$/);
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
    writeFileSync(join(fixture.root, 'probe.mjs'), `${readFileSync(join(fixture.root, 'probe.mjs'), 'utf8')}\n// dirty\n`, 'utf8');
    const fragment = await collectCanonicalCutoverReadinessFragment({
      repoRoot: fixture.root,
      expectedHeadSha: fixture.headSha,
      expectedRuntimeImageId: RUNTIME_IMAGE,
      probes: { registryPersistence: descriptor() },
    });

    assert.equal(fragment.evidence.registryPersistence, undefined);
    assert.ok(fragment.errors.includes('registryPersistence:source-dirty'));
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

    const merged = mergeCanonicalCutoverReadinessEvidence({
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
