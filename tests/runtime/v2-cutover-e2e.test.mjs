import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const FIXED_NOW = '2026-10-18T00:45:00.000Z';
const STALE_STARTED_AT = '2026-10-17T23:40:00.000Z';
const STALE_DEADLINE_AT = '2026-10-17T23:41:00.000Z';

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeGitProject(name) {
  const root = mkdtempSync(join(tmpdir(), `orchestra-v2-cutover-${name}-`));
  writeFileSync(join(root, 'README.md'), `${name}\n`, 'utf8');
  git(root, 'init');
  git(root, 'config', 'user.email', 'orchestra-v2-tests@example.invalid');
  git(root, 'config', 'user.name', 'Orchestra V2 Tests');
  git(root, 'add', '.');
  git(root, 'commit', '-m', `fixture: ${name}`);
  return root;
}

function sourceFingerprint(root) {
  return Object.freeze({
    head: git(root, 'rev-parse', 'HEAD'),
    status: git(root, 'status', '--porcelain=v1'),
    readmeDigest: sha256(readFileSync(join(root, 'README.md'))),
  });
}

function runtimeImageInput(version, text) {
  return {
    version,
    engineCompatibility: { min: '2.0.0', max: '2.x' },
    providerAdapterCompatibility: {
      codex: { min: '2.0.0', max: '2.x' },
      antigravity: { min: '2.0.0', max: '2.x' },
    },
    files: {
      'runtime/instructions.txt': Buffer.from(text, 'utf8'),
    },
  };
}

function actor(fill = 'a') {
  return {
    schema: 'orchestra.actor-provenance.v2',
    provider: 'codex',
    subjectHash: `sha256:${fill.repeat(64)}`,
    source: 'PROVIDER_FACT',
    observedAt: FIXED_NOW,
  };
}

function work(project, id) {
  return {
    schema: 'orchestra.work-unit.v2',
    workId: id,
    projectId: project.projectId,
    taskId: `task-${id}`,
    generation: 0,
    runtimeImage: project.runtime.pinnedImage,
    instructionEpoch: project.runtime.instructionEpoch,
    state: 'IMPLEMENTING',
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
  };
}

function staleOperation(project, currentWork, runtimeOwnerId) {
  return {
    schema: 'orchestra.operation.v2',
    operationId: 'op-cutover-owner-loss',
    projectId: project.projectId,
    workId: currentWork.workId,
    generation: currentWork.generation,
    kind: 'DIRECT_MUTATION',
    actorRef: 'codex:cutover-owner-loss',
    capabilities: ['WORKSPACE_EDIT'],
    workflowState: 'RUNNING',
    liveness: 'LIVE',
    startedAt: STALE_STARTED_AT,
    heartbeatAt: STALE_STARTED_AT,
    deadlineAt: STALE_DEADLINE_AT,
    runtimeOwnerRef: runtimeOwnerId,
    workspaceRef: null,
    resultRef: null,
  };
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function f7Fixture(classifyLegacyInventoryEntry) {
  const path = '.orchestra/state/delegation/parallel-groups/tsuzuki-f7-g2-parallel-2/group.json';
  const record = {
    schema: 'orchestra.parallel-group-state.v1',
    group: { groupId: 'tsuzuki-f7-g2-parallel-2' },
    state: 'RUNNING',
    memberArtifactIds: [],
    compositeArtifactId: null,
    createdAt: '2026-10-16T15:27:58.440Z',
    updatedAt: '2026-10-16T15:27:58.446Z',
  };
  const bytes = jsonBytes(record);
  const entry = {
    path,
    category: 'TRANSIENT_PARALLEL_GROUP',
    schema: 'orchestra.parallel-group-state.v1',
    version: 1,
    digest: sha256(bytes),
    integrity: 'PARSED',
    dispositionBasis: 'TRANSIENT_STATE',
    private: false,
  };
  const facts = {
    groupId: 'tsuzuki-f7-g2-parallel-2',
    persistedState: 'RUNNING',
    createdAt: '2026-10-16T15:27:58.440Z',
    updatedAt: '2026-10-16T15:27:58.446Z',
    memberArtifactIds: [],
    compositeArtifactId: null,
    survivingWorkspaces: 2,
    ownerProcessProof: 'ABSENT',
    canonicalPromotion: false,
    runtimeVersion: 'v1.4.2',
  };
  return {
    entry,
    facts,
    bytes,
    classification: classifyLegacyInventoryEntry({ entry, facts }),
  };
}

if (NODE_MAJOR < 24) {
  test('V2-11 cutover E2E remains gated from the Node 20 v1 baseline', () => {
    assert.ok(NODE_MAJOR < 24);
  });
} else {
  test('dead factual owner recovers before explicit upgrade and rollback without rewriting project source', async () => {
    const [
      registryModule,
      reconciliationModule,
      ownerStoreModule,
      runtimeStoreModule,
      runtimeManagerModule,
      workAuthorityModule,
    ] = await Promise.all([
      import('../../v2/global/project-registry.mjs'),
      import('../../v2/global/reconciliation.mjs'),
      import('../../v2/liveness/runtime-owner-store.mjs'),
      import('../../v2/runtime-images/store.mjs'),
      import('../../v2/runtime-images/manager.mjs'),
      import('../../v2/authority/work-authority.mjs'),
    ]);

    const projectRoot = makeGitProject('crash-rollback');
    const home = mkdtempSync(join(tmpdir(), 'orchestra-v2-cutover-home-'));
    const before = sourceFingerprint(projectRoot);
    const imageStore = runtimeStoreModule.createRuntimeImageStore({ orchestraHome: home });
    const imageA = await imageStore.install(runtimeImageInput('2.0.0', 'runtime-a'));
    const imageB = await imageStore.install(runtimeImageInput('2.1.0', 'runtime-b'));
    const registry = registryModule.createGlobalProjectRegistry({ home });

    try {
      const registered = await registry.registerWorkspace({
        root: projectRoot,
        runtimeImage: imageA.imageId,
        instructionEpoch: 0,
        trustMode: 'trusted',
      });
      assert.equal(registered.ok, true);
      const project = registered.project;
      const initialWork = work(project, 'work-cutover-owner-loss');
      assert.equal(registry.state.work.startCurrent(initialWork).ok, true);

      const runtimeOwnerId = 'owner-cutover-dead-process';
      const operation = staleOperation(project, initialWork, runtimeOwnerId);
      assert.equal(registry.state.operations.begin({
        expectedGeneration: initialWork.generation,
        operation,
      }).ok, true);

      const ownerStore = ownerStoreModule.createRuntimeOwnerStore({ rootDir: join(home, 'runtime-owners') });
      const ownerRegistered = await ownerStore.register({
        schema: 'orchestra.runtime-owner.v2',
        runtimeOwnerId,
        operationId: operation.operationId,
        kind: 'LOCAL_PROCESS',
        registeredAt: STALE_STARTED_AT,
        process: {
          pid: 2147483647,
          startIdentity: 'cutover-process-birth-id',
        },
        proof: { tokenHash: `sha256:${'7'.repeat(64)}` },
      });
      assert.equal(ownerRegistered.ok, true);

      assert.equal(registry.state.sessionObservations.put({
        provider: 'codex',
        projectId: project.projectId,
        actorIdHash: actor().subjectHash,
        observedInstructionEpoch: 0,
        observedWorkId: initialWork.workId,
        observedGeneration: initialWork.generation,
        observedAt: STALE_STARTED_AT,
      }).ok, true);

      const reconciler = reconciliationModule.createGlobalOperationReconciler({
        state: registry.state,
        home,
        now: () => FIXED_NOW,
        readProcessIdentity: async () => ({ status: 'ABSENT' }),
      });
      const status = await reconciler.inspect({ projectId: project.projectId });
      assert.equal(status.ok, true);
      assert.equal(status.operations.length, 1);
      assert.equal(status.operations[0].assessment.liveness, 'STALE_RECOVERABLE');
      assert.equal(status.operations[0].actionRequired, 'RUN_RECOVERY');

      const recovered = await reconciler.recover({
        projectId: project.projectId,
        operationId: operation.operationId,
        commandId: 'cutover-recover-dead-owner',
      });
      assert.equal(recovered.ok, true);
      assert.equal(recovered.recovered, true);
      assert.notEqual(registry.state.operations.inspect(operation.operationId).workflowState, 'RUNNING');

      const authority = workAuthorityModule.createWorkAuthority({ state: registry.state });
      const abandoned = authority.abandon({
        projectId: project.projectId,
        expectedWorkId: initialWork.workId,
        expectedGeneration: initialWork.generation,
        commandId: 'cutover-quiesce-after-recovery',
        reason: 'CUTOVER_RECOVERY_COMPLETE',
      });
      assert.equal(abandoned.ok, true);
      assert.equal(registry.state.work.current(project.projectId), null);

      const manager = runtimeManagerModule.createRuntimeImageManager({
        state: registry.state,
        imageStore,
        statusReconciler: reconciler,
        engineVersion: '2.0.0',
        providerAdapterVersions: {
          codex: '2.0.0',
          antigravity: '2.0.0',
        },
      });
      const upgraded = await manager.upgradeProject({
        projectId: project.projectId,
        targetImageId: imageB.imageId,
        commandId: 'cutover-upgrade-b',
      });
      assert.equal(upgraded.ok, true);
      assert.equal(upgraded.previousImageId, imageA.imageId);
      assert.equal(upgraded.targetImageId, imageB.imageId);
      assert.equal(upgraded.project.runtime.instructionEpoch, 1);

      const workAfterUpgrade = work(upgraded.project, 'work-cutover-after-upgrade');
      assert.equal(registry.state.work.startCurrent(workAfterUpgrade).ok, true);
      const staleAttach = authority.attach({
        projectId: project.projectId,
        actor: actor(),
        observedInstructionEpoch: 0,
      });
      assert.equal(staleAttach.allowed, false);
      assert.equal(staleAttach.reason, 'SESSION_RUNTIME_STALE');
      assert.equal(staleAttach.currentInstructionEpoch, 1);

      const quiescedForRollback = authority.abandon({
        projectId: project.projectId,
        expectedWorkId: workAfterUpgrade.workId,
        expectedGeneration: workAfterUpgrade.generation,
        commandId: 'cutover-quiesce-before-rollback',
        reason: 'CUTOVER_ROLLBACK_PREPARED',
      });
      assert.equal(quiescedForRollback.ok, true);

      const rolledBack = await manager.rollbackProject({
        projectId: project.projectId,
        targetImageId: imageA.imageId,
        commandId: 'cutover-rollback-a',
      });
      assert.equal(rolledBack.ok, true);
      assert.equal(rolledBack.previousImageId, imageB.imageId);
      assert.equal(rolledBack.targetImageId, imageA.imageId);
      assert.equal(rolledBack.project.runtime.instructionEpoch, 2);

      assert.deepEqual(sourceFingerprint(projectRoot), before);
    } finally {
      registry.close();
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('Tsuzuki F7 orphan migrates into explicit recovery work without inventing LIVE or success', async () => {
    const [
      registryModule,
      reconciliationModule,
      importerModule,
      classifierModule,
    ] = await Promise.all([
      import('../../v2/global/project-registry.mjs'),
      import('../../v2/global/reconciliation.mjs'),
      import('../../v2/migration/import.mjs'),
      import('../../v2/migration/transient-classifier.mjs'),
    ]);

    const workspace = makeGitProject('tsuzuki-f7-cutover');
    const home = mkdtempSync(join(tmpdir(), 'orchestra-v2-f7-cutover-home-'));
    const fixture = f7Fixture(classifierModule.classifyLegacyInventoryEntry);
    assert.equal(fixture.classification.disposition, 'RECOVERABLE_IMPORT');
    assert.equal(fixture.classification.reconciliation.liveness, 'UNKNOWN');
    assert.equal(fixture.classification.reconciliation.successClaim, false);
    assert.equal(fixture.classification.reconciliation.operationImportEligible, false);

    const registry = registryModule.createGlobalProjectRegistry({ home });
    try {
      const importer = importerModule.createLegacyMigrationImporter({ projectRegistry: registry });
      const imported = await importer.apply({
        workspace,
        commandId: 'cutover-f7-import',
        runtimeImage: 'runtime-image-migration',
        instructionEpoch: 7,
        trustMode: 'trusted',
        inventory: [fixture.entry],
        classifications: [{ path: fixture.entry.path, result: fixture.classification }],
        durableFacts: {},
        privateArchives: [],
        transientFacts: [{
          path: fixture.entry.path,
          bytes: fixture.bytes,
          provenanceComplete: true,
          facts: fixture.facts,
        }],
      });
      assert.equal(imported.ok, true);
      assert.equal(imported.code, 'MIGRATION_TRANSIENT_IMPORT_APPLIED');
      assert.equal(imported.transient[0].operationId, null);
      assert.equal(imported.recoveryWork.state, 'MIGRATION_RECOVERY_REQUIRED');

      const reconciler = reconciliationModule.createGlobalOperationReconciler({
        state: registry.state,
        home,
        now: () => FIXED_NOW,
        readProcessIdentity: async () => ({ status: 'ABSENT' }),
        workspaceRecovery: {
          async inspect(workspaceRef) { return { workspaceRef, status: 'UNKNOWN' }; },
          async cleanup() { throw new Error('ambiguous F7 state must never authorize cleanup'); },
        },
      });
      const status = await reconciler.inspect({ projectId: imported.project.projectId });
      assert.equal(status.ok, true);
      assert.equal(status.work.workId, imported.recoveryWork.workId);
      assert.deepEqual(status.operations, []);
      assert.ok(status.work.blockers.some((value) => value.startsWith('MIGRATION_TRANSIENT_UNKNOWN:')));

      const fabricatedRecovery = await reconciler.recover({
        projectId: imported.project.projectId,
        operationId: 'op-f7-does-not-exist',
        commandId: 'cutover-f7-no-fabricated-recovery',
      });
      assert.equal(fabricatedRecovery.ok, false);
      assert.equal(fabricatedRecovery.reason, 'OPERATION_NOT_FOUND');

      const explicitlyResolved = registry.state.work.abandonCurrent({
        projectId: imported.project.projectId,
        expectedWorkId: imported.recoveryWork.workId,
        expectedGeneration: imported.recoveryWork.generation,
        commandId: 'cutover-f7-explicit-resolution',
        reason: 'MIGRATION_TRANSIENT_EXPLICIT_ABANDON',
      });
      assert.equal(explicitlyResolved.ok, true);
      assert.equal(registry.state.work.current(imported.project.projectId), null);
    } finally {
      registry.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
}
