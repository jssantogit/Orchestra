import test from 'node:test';
import assert from 'node:assert/strict';

import { FIELD_TEST_SCENARIOS } from '../../v2/cutover/field-evidence.mjs';
import {
  collectCutoverReadinessFragment,
  mergeCutoverReadinessEvidence,
} from '../../v2/cutover/readiness-evidence.mjs';

const HEAD = 'a'.repeat(40);
const STALE_HEAD = 'f'.repeat(40);
const RUNTIME_IMAGE = `sha256:${'b'.repeat(64)}`;
const STALE_RUNTIME_IMAGE = `sha256:${'c'.repeat(64)}`;

function probeResult(facts = {}, {
  headSha = HEAD,
  runtimeImageId = RUNTIME_IMAGE,
  evidenceRef = `sha256:${'1'.repeat(64)}`,
} = {}) {
  return {
    ok: true,
    headSha,
    runtimeImageId,
    facts,
    evidenceRefs: [evidenceRef],
  };
}

function providerFieldEvidence(provider) {
  return FIELD_TEST_SCENARIOS.map((scenarioId, index) => ({
    schema: 'orchestra.cutover-field-evidence.v2',
    version: 1,
    provider: { family: provider, version: provider === 'codex' ? '0.159.2' : '1.4.2' },
    project: { lineageId: `lineage-${provider}` },
    runtimeImageId: RUNTIME_IMAGE,
    headSha: HEAD,
    scenarioId,
    factualResult: {
      ok: true,
      code: `FACT_${index + 1}`,
      factRef: `evidence:v2-11:${provider}:${scenarioId.toLowerCase()}`,
    },
    terminalStatus: 'VERIFIED',
    observedAt: '2026-10-18T18:00:00.000Z',
    evidenceRefs: [`sha256:${String(index + 1).padStart(64, '0')}`],
    operatorAttestation: null,
  }));
}

function scalarProbes() {
  return {
    registryPersistence: async () => probeResult({ restartVerified: true }),
    runtimeLifecycle: async () => probeResult({
      installed: true,
      pinned: true,
      rollbackVerified: true,
      runtimeImageId: RUNTIME_IMAGE,
    }),
    reconciliation: async () => probeResult({
      staleRecoveryVerified: true,
      dirtyRecoveryVerified: true,
    }),
    experiencePrivacy: async () => probeResult({ sanitizedGlobalProjectionVerified: true }),
    rsiReplay: async () => probeResult({
      trainVerified: true,
      evaluateVerified: true,
      holdoutVerified: true,
      lineageCount: 4,
    }),
    migration: async () => probeResult({
      migrationVerified: true,
      tsuzukiF7Verified: true,
    }),
    selfHost: async () => probeResult({
      projectId: 'prj_orchestra',
      lineageId: 'lineage_orchestra',
      runtimeImageId: RUNTIME_IMAGE,
      noFullLocalGovernanceRuntime: true,
    }),
  };
}

test('collector promotes only factual probe results bound to the exact head/runtime with sanitized refs', async () => {
  const fragment = await collectCutoverReadinessFragment({
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: RUNTIME_IMAGE,
    probes: {
      registryPersistence: async () => probeResult({ restartVerified: true }),
    },
  });

  assert.equal(fragment.headSha, HEAD);
  assert.equal(fragment.runtimeImageId, RUNTIME_IMAGE);
  assert.equal(fragment.evidence.registryPersistence.status, 'VERIFIED');
  assert.equal(fragment.evidence.registryPersistence.headSha, HEAD);
  assert.equal(fragment.evidence.registryPersistence.runtimeImageId, RUNTIME_IMAGE);
  assert.deepEqual(fragment.evidence.registryPersistence.facts, { restartVerified: true });
  assert.deepEqual(fragment.errors, []);
});

test('stale head/runtime and raw evidence are never promoted to VERIFIED readiness', async () => {
  const fragment = await collectCutoverReadinessFragment({
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: RUNTIME_IMAGE,
    probes: {
      registryPersistence: async () => probeResult({}, { headSha: STALE_HEAD }),
      experiencePrivacy: async () => probeResult({}, { runtimeImageId: STALE_RUNTIME_IMAGE }),
      migration: async () => probeResult({}, { evidenceRef: 'raw:provider-transcript' }),
    },
  });

  assert.equal(fragment.evidence.registryPersistence, undefined);
  assert.equal(fragment.evidence.experiencePrivacy, undefined);
  assert.equal(fragment.evidence.migration, undefined);
  assert.ok(fragment.errors.includes('registryPersistence:headSha'));
  assert.ok(fragment.errors.includes('experiencePrivacy:runtimeImageId'));
  assert.ok(fragment.errors.includes('migration:evidenceRefs'));
});

test('caller-supplied booleans or records cannot substitute for executing a probe', async () => {
  const fragment = await collectCutoverReadinessFragment({
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: RUNTIME_IMAGE,
    probes: {
      registryPersistence: { ok: true, verified: true },
      experiencePrivacy: true,
    },
  });

  assert.equal(fragment.evidence.registryPersistence, undefined);
  assert.equal(fragment.evidence.experiencePrivacy, undefined);
  assert.ok(fragment.errors.includes('registryPersistence:probe'));
  assert.ok(fragment.errors.includes('experiencePrivacy:probe'));
});

test('provider readiness is derived only from the canonical six-scenario field evaluator', async () => {
  const fragment = await collectCutoverReadinessFragment({
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: RUNTIME_IMAGE,
    probes: scalarProbes(),
  });

  const result = mergeCutoverReadinessEvidence({
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: RUNTIME_IMAGE,
    fragments: [fragment],
    providerFieldEvidence: {
      codex: providerFieldEvidence('codex'),
      antigravity: providerFieldEvidence('antigravity'),
    },
  });

  assert.equal(result.evidence.providers.codex.status, 'VERIFIED');
  assert.equal(result.evidence.providers.antigravity.status, 'VERIFIED');
  assert.equal(result.providers.codex.verified, true);
  assert.equal(result.providers.antigravity.verified, true);

  const stale = providerFieldEvidence('codex');
  stale[0] = { ...stale[0], runtimeImageId: STALE_RUNTIME_IMAGE };
  const rejected = mergeCutoverReadinessEvidence({
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: RUNTIME_IMAGE,
    fragments: [fragment],
    providerFieldEvidence: {
      codex: stale,
      antigravity: providerFieldEvidence('antigravity'),
    },
  });
  assert.equal(rejected.evidence.providers.codex, undefined);
  assert.equal(rejected.providers.codex.verified, false);
});

test('independent Windows/POSIX and Project fragments merge into the existing readiness evaluator without bypasses', async () => {
  const common = await collectCutoverReadinessFragment({
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: RUNTIME_IMAGE,
    probes: scalarProbes(),
  });
  const windows = await collectCutoverReadinessFragment({
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: RUNTIME_IMAGE,
    probes: {
      platforms: {
        windows: async () => probeResult({ nativeVerified: true }),
      },
      projects: [
        async () => probeResult({
          projectId: 'prj_alpha',
          lineageId: 'lineage_alpha',
          noFullLocalGovernanceRuntime: true,
        }),
      ],
    },
  });
  const posix = await collectCutoverReadinessFragment({
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: RUNTIME_IMAGE,
    probes: {
      platforms: {
        posix: async () => probeResult({ nativeVerified: true }),
      },
      projects: [
        async () => probeResult({
          projectId: 'prj_beta',
          lineageId: 'lineage_beta',
          noFullLocalGovernanceRuntime: true,
        }),
      ],
    },
  });

  const result = mergeCutoverReadinessEvidence({
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: RUNTIME_IMAGE,
    fragments: [common, windows, posix],
    providerFieldEvidence: {
      codex: providerFieldEvidence('codex'),
      antigravity: providerFieldEvidence('antigravity'),
    },
  });

  assert.equal(result.readiness.ready, true, JSON.stringify(result.readiness));
  assert.equal(result.readiness.code, 'CUTOVER_READY');
  assert.equal(result.evidence.projects.length, 2);
  assert.equal(result.evidence.platforms.windows.status, 'VERIFIED');
  assert.equal(result.evidence.platforms.posix.status, 'VERIFIED');
});

test('readiness rejects two Projects collected from different Orchestra Homes', async () => {
  const common = await collectCutoverReadinessFragment({
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: RUNTIME_IMAGE,
    probes: {
      ...scalarProbes(),
      platforms: {
        windows: async () => probeResult({ nativeVerified: true }),
        posix: async () => probeResult({ nativeVerified: true }),
      },
      projects: [
        async () => probeResult({
          projectId: 'prj_alpha',
          lineageId: 'lineage_alpha',
          noFullLocalGovernanceRuntime: true,
          homeIdentity: `sha256:${'a'.repeat(64)}`,
        }),
        async () => probeResult({
          projectId: 'prj_beta',
          lineageId: 'lineage_beta',
          noFullLocalGovernanceRuntime: true,
          homeIdentity: `sha256:${'b'.repeat(64)}`,
        }),
      ],
    },
  });

  const result = mergeCutoverReadinessEvidence({
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: RUNTIME_IMAGE,
    fragments: [common],
    providerFieldEvidence: {
      codex: providerFieldEvidence('codex'),
      antigravity: providerFieldEvidence('antigravity'),
    },
  });

  assert.equal(result.readiness.ready, false);
  assert.ok(result.readiness.invalid.includes('projects:home-identity'));
});

test('duplicate Project lineage and incomplete dirty/RSI facts remain NOT READY after collection', async () => {
  const common = await collectCutoverReadinessFragment({
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: RUNTIME_IMAGE,
    probes: {
      ...scalarProbes(),
      reconciliation: async () => probeResult({ staleRecoveryVerified: true }),
      rsiReplay: async () => probeResult({ trainVerified: true, evaluateVerified: true }),
      platforms: {
        windows: async () => probeResult({ nativeVerified: true }),
        posix: async () => probeResult({ nativeVerified: true }),
      },
      projects: [
        async () => probeResult({
          projectId: 'prj_alpha',
          lineageId: 'lineage_same',
          noFullLocalGovernanceRuntime: true,
        }),
        async () => probeResult({
          projectId: 'prj_beta',
          lineageId: 'lineage_same',
          noFullLocalGovernanceRuntime: true,
        }),
      ],
    },
  });

  const result = mergeCutoverReadinessEvidence({
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: RUNTIME_IMAGE,
    fragments: [common],
    providerFieldEvidence: {
      codex: providerFieldEvidence('codex'),
      antigravity: providerFieldEvidence('antigravity'),
    },
  });

  assert.equal(result.readiness.ready, false);
  assert.ok(result.readiness.invalid.includes('reconciliation:dirtyRecoveryVerified'));
  assert.ok(result.readiness.invalid.includes('rsiReplay:holdoutVerified'));
  assert.ok(result.readiness.invalid.includes('projects:independent-lineages'));
});

test('fragment identity conflicts fail closed instead of mixing evidence across candidates', async () => {
  const current = await collectCutoverReadinessFragment({
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: RUNTIME_IMAGE,
    probes: { registryPersistence: async () => probeResult() },
  });
  const stale = {
    ...current,
    headSha: STALE_HEAD,
  };

  const result = mergeCutoverReadinessEvidence({
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: RUNTIME_IMAGE,
    fragments: [current, stale],
    providerFieldEvidence: {},
  });

  assert.ok(result.errors.includes('fragment[1]:headSha'));
  assert.equal(result.readiness.ready, false);
});
