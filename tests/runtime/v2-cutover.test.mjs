import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateCutoverReadiness,
  CUTOVER_EVIDENCE_STATUS,
} from '../../v2/cutover/readiness.mjs';
import { verifyOrchestraSelfHost } from '../../v2/cutover/self-host.mjs';
import { verifyMultiProjectIsolation } from '../../v2/cutover/multi-project.mjs';

const HEAD = 'a'.repeat(40);
const RUNTIME_IMAGE = 'sha256:' + 'b'.repeat(64);
const RUNTIME_IMAGE_B = 'sha256:' + 'd'.repeat(64);
const FIXED_NOW = '2026-10-17T23:30:00.000Z';
const GLOBAL_LAUNCHER = fileURLToPath(new URL('../../v2/global/orchestra.mjs', import.meta.url));
const CURRENT_NODE_MAJOR = Number(process.versions.node.split('.')[0]);

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

function makeOrchestraProjectCopy() {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-v2-self-host-'));
  mkdirSync(join(root, 'v2', 'global'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'orchestra', type: 'module' }, null, 2));
  writeFileSync(
    join(root, 'v2', 'global', 'orchestra.mjs'),
    readFileSync(GLOBAL_LAUNCHER, 'utf8'),
  );
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'orchestra-v2-tests@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Orchestra V2 Tests'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture: Orchestra self-host copy'], { cwd: root, stdio: 'ignore' });
  return root;
}

function makeGitProject(name) {
  const root = mkdtempSync(join(tmpdir(), `orchestra-v2-${name}-`));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, private: true }, null, 2));
  writeFileSync(join(root, 'README.md'), `${name}\n`, 'utf8');
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'orchestra-v2-tests@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Orchestra V2 Tests'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', `fixture: ${name}`], { cwd: root, stdio: 'ignore' });
  return root;
}

function factualActor(provider = 'codex', fill = 'c') {
  return {
    schema: 'orchestra.actor-provenance.v2',
    provider,
    subjectHash: `sha256:${fill.repeat(64)}`,
    source: 'PROVIDER_FACT',
    observedAt: FIXED_NOW,
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

if (CURRENT_NODE_MAJOR >= 24) {
  test('Orchestra self-hosts through the global registry, current Work and thin Codex shim', async () => {
    const { installCodexV2Shim } = await import('../../v2/providers/codex/shim-manager.mjs');
    const projectRoot = makeOrchestraProjectCopy();
    const home = mkdtempSync(join(tmpdir(), 'orchestra-v2-home-'));

    const result = await verifyOrchestraSelfHost({
      projectRoot,
      home,
      launcherPath: GLOBAL_LAUNCHER,
      runtimeImage: RUNTIME_IMAGE,
      instructionEpoch: 7,
      actor: factualActor(),
      installThinShim: installCodexV2Shim,
      now: () => FIXED_NOW,
    });

    assert.equal(result.ok, true);
    assert.equal(result.project.runtime.pinnedImage, RUNTIME_IMAGE);
    assert.equal(result.project.runtime.instructionEpoch, 7);
    assert.equal(result.attach.allowed, true);
    assert.equal(result.attach.workId, result.work.workId);
    assert.equal(result.mutationAuthorization.allowed, true);
    assert.equal(result.operationBegin.ok, true);
    assert.equal(result.operationTerminalization.ok, true);
    assert.equal(result.status.ok, true);
    assert.equal(result.staleEpoch.allowed, false);
    assert.equal(result.staleEpoch.reason, 'SESSION_RUNTIME_STALE');
    assert.equal(result.staleGeneration.allowed, false);
    assert.equal(result.staleGeneration.reason, 'STALE_GENERATION');
    assert.equal(result.staleWork.allowed, false);
    assert.deepEqual(result.shim.files, ['.codex/hooks.json', '.codex/orchestra-v2-hook.mjs']);
    assert.equal(result.noFullLocalGovernanceRuntime, true);
    assert.equal(result.globalStateOutsideProject, true);
  });

  test('self-host verification rejects a non-Orchestra repository before registration', async () => {
    const { installCodexV2Shim } = await import('../../v2/providers/codex/shim-manager.mjs');
    const projectRoot = mkdtempSync(join(tmpdir(), 'not-orchestra-'));
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'other-project' }));
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
    const home = mkdtempSync(join(tmpdir(), 'orchestra-v2-home-'));

    const result = await verifyOrchestraSelfHost({
      projectRoot,
      home,
      launcherPath: GLOBAL_LAUNCHER,
      runtimeImage: RUNTIME_IMAGE,
      instructionEpoch: 1,
      actor: factualActor(),
      installThinShim: installCodexV2Shim,
      now: () => FIXED_NOW,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'CUTOVER_SELF_HOST_NOT_ORCHESTRA');
  });

  test('two independent Projects stay isolated under one global Orchestra Home', async () => {
    const { installCodexV2Shim } = await import('../../v2/providers/codex/shim-manager.mjs');
    const home = mkdtempSync(join(tmpdir(), 'orchestra-v2-multi-project-home-'));
    const rootA = makeGitProject('cutover-alpha');
    const rootB = makeGitProject('cutover-beta');

    const result = await verifyMultiProjectIsolation({
      home,
      launcherPath: GLOBAL_LAUNCHER,
      installThinShim: installCodexV2Shim,
      removeThinShim({ targetDir, files }) {
        for (const relativePath of files) rmSync(join(targetDir, relativePath), { force: true });
        return { ok: true };
      },
      projects: [
        {
          root: rootA,
          runtimeImage: RUNTIME_IMAGE,
          instructionEpoch: 2,
          actor: factualActor('codex', 'a'),
          evidenceRef: 'evidence:alpha-private',
        },
        {
          root: rootB,
          runtimeImage: RUNTIME_IMAGE_B,
          instructionEpoch: 9,
          actor: factualActor('codex', 'b'),
          evidenceRef: 'evidence:beta-private',
        },
      ],
      now: () => FIXED_NOW,
    });

    assert.equal(result.ok, true);
    assert.notEqual(result.projects[0].projectId, result.projects[1].projectId);
    assert.notEqual(result.projects[0].lineageId, result.projects[1].lineageId);
    assert.equal(result.projects[0].runtime.pinnedImage, RUNTIME_IMAGE);
    assert.equal(result.projects[1].runtime.pinnedImage, RUNTIME_IMAGE_B);
    assert.notEqual(result.works[0].workId, result.works[1].workId);
    assert.deepEqual(result.works[0].evidenceRefs, ['evidence:alpha-private']);
    assert.deepEqual(result.works[1].evidenceRefs, ['evidence:beta-private']);
    assert.equal(result.operations[0].projectId, result.projects[0].projectId);
    assert.equal(result.operations[1].projectId, result.projects[1].projectId);
    assert.equal(result.dirtyIsolation.projectAAction, 'RESOLVE_DIRTY_WORKSPACE');
    assert.equal(result.dirtyIsolation.projectBMutationAllowed, true);
    assert.equal(result.providerIsolation.sessionCrossProjectRejected, true);
    assert.equal(result.providerIsolation.correlationCrossProjectRejected, true);
    assert.equal(result.experience.crossProjectCount, 2);
    assert.equal(result.experience.crossProjectPrivateIdsAbsent, true);
    assert.equal(result.experience.projectPrivateIsolation, true);
    assert.equal(result.shimIsolation.projectARemoved, true);
    assert.equal(result.shimIsolation.projectBStateIntact, true);
  });
} else {
  test('V2-11 cutover harnesses remain import-safe on the Node 20 v1 baseline', () => {
    assert.equal(typeof verifyOrchestraSelfHost, 'function');
    assert.equal(typeof verifyMultiProjectIsolation, 'function');
  });
}
