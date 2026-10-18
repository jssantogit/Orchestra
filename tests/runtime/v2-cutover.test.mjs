import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateCutoverReadiness,
  CUTOVER_EVIDENCE_STATUS,
} from '../../v2/cutover/readiness.mjs';

const HEAD = 'a'.repeat(40);
const RUNTIME_IMAGE = 'sha256:' + 'b'.repeat(64);

function verified(headSha = HEAD, facts = {}) {
  return {
    status: CUTOVER_EVIDENCE_STATUS.VERIFIED,
    headSha,
    facts,
  };
}

function completeEvidence() {
  return {
    registryPersistence: verified(),
    providers: {
      codex: verified(),
      antigravity: verified(),
    },
    runtimeLifecycle: verified(HEAD, {
      installed: true,
      pinned: true,
      rollbackVerified: true,
      runtimeImageId: RUNTIME_IMAGE,
    }),
    reconciliation: verified(HEAD, {
      staleRecoveryVerified: true,
      dirtyRecoveryVerified: true,
    }),
    experiencePrivacy: verified(),
    rsiReplay: verified(HEAD, {
      trainVerified: true,
      evaluateVerified: true,
      holdoutVerified: true,
    }),
    migration: verified(HEAD, {
      migrationVerified: true,
      tsuzukiF7Verified: true,
    }),
    platforms: {
      windows: verified(),
      posix: verified(),
    },
    projects: [
      verified(HEAD, {
        projectId: 'prj_alpha',
        lineageId: 'lineage_alpha',
        noFullLocalGovernanceRuntime: true,
      }),
      verified(HEAD, {
        projectId: 'prj_beta',
        lineageId: 'lineage_beta',
        noFullLocalGovernanceRuntime: true,
      }),
    ],
    selfHost: verified(HEAD, {
      projectId: 'prj_orchestra',
      lineageId: 'lineage_orchestra',
      runtimeImageId: RUNTIME_IMAGE,
      noFullLocalGovernanceRuntime: true,
    }),
    v1Compatibility: verified(),
  };
}

test('cutover readiness requires every factual v2 evidence family on the exact head', () => {
  const result = evaluateCutoverReadiness({
    expectedHeadSha: HEAD,
    evidence: completeEvidence(),
  });

  assert.equal(result.ready, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.invalid, []);
});

test('missing evidence keeps readiness false even when v1 compatibility is green', () => {
  const evidence = completeEvidence();
  delete evidence.experiencePrivacy;
  evidence.v1Compatibility = verified();
  evidence.ready = true;

  const result = evaluateCutoverReadiness({
    expectedHeadSha: HEAD,
    evidence,
  });

  assert.equal(result.ready, false);
  assert.ok(result.missing.includes('experiencePrivacy'));
});

test('one lineage repeated twice does not satisfy the independent-project requirement', () => {
  const evidence = completeEvidence();
  evidence.projects[1] = verified(HEAD, {
    projectId: 'prj_beta',
    lineageId: 'lineage_alpha',
    noFullLocalGovernanceRuntime: true,
  });

  const result = evaluateCutoverReadiness({
    expectedHeadSha: HEAD,
    evidence,
  });

  assert.equal(result.ready, false);
  assert.ok(result.invalid.includes('projects:independent-lineages'));
});

test('stale exact-head evidence cannot satisfy readiness', () => {
  const evidence = completeEvidence();
  evidence.providers.codex = verified('c'.repeat(40));

  const result = evaluateCutoverReadiness({
    expectedHeadSha: HEAD,
    evidence,
  });

  assert.equal(result.ready, false);
  assert.ok(result.invalid.includes('providers.codex:headSha'));
});

test('failed or unknown provider field results are not success', () => {
  for (const status of [CUTOVER_EVIDENCE_STATUS.FAILED, CUTOVER_EVIDENCE_STATUS.UNKNOWN]) {
    const evidence = completeEvidence();
    evidence.providers.antigravity = {
      ...verified(),
      status,
    };

    const result = evaluateCutoverReadiness({
      expectedHeadSha: HEAD,
      evidence,
    });

    assert.equal(result.ready, false, status);
    assert.ok(result.invalid.includes('providers.antigravity:status'), status);
  }
});

test('a caller supplied readiness boolean cannot force the result', () => {
  const evidence = {
    ready: true,
    v1Compatibility: verified(),
  };

  const result = evaluateCutoverReadiness({
    expectedHeadSha: HEAD,
    ready: true,
    evidence,
  });

  assert.equal(result.ready, false);
  assert.ok(result.missing.length > 0);
});

test('project-local full governance runtime blocks cutover readiness', () => {
  const evidence = completeEvidence();
  evidence.projects[0] = verified(HEAD, {
    projectId: 'prj_alpha',
    lineageId: 'lineage_alpha',
    noFullLocalGovernanceRuntime: false,
  });

  const result = evaluateCutoverReadiness({
    expectedHeadSha: HEAD,
    evidence,
  });

  assert.equal(result.ready, false);
  assert.ok(result.invalid.includes('projects:no-full-local-governance-runtime'));
});
