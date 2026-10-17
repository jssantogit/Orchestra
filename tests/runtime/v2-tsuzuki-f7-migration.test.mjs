import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createLegacyMigrationImporter } from "../../v2/migration/import.mjs";
import { classifyLegacyInventoryEntry } from "../../v2/migration/transient-classifier.mjs";

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

const tsuzukiF7Entry = Object.freeze({
  path: ".orchestra/state/delegation/parallel-groups/tsuzuki-f7-g2-parallel-2/group.json",
  category: "TRANSIENT_PARALLEL_GROUP",
  schema: "orchestra.parallel-group-state.v1",
  version: 1,
  digest: `sha256:${"f".repeat(64)}`,
  integrity: "PARSED",
  dispositionBasis: "TRANSIENT_STATE",
  private: false,
});

const tsuzukiF7Facts = Object.freeze({
  groupId: "tsuzuki-f7-g2-parallel-2",
  persistedState: "RUNNING",
  createdAt: "2026-10-16T15:27:58.440Z",
  updatedAt: "2026-10-16T15:27:58.446Z",
  memberArtifactIds: Object.freeze([]),
  compositeArtifactId: null,
  survivingWorkspaces: 2,
  ownerProcessProof: "ABSENT",
  canonicalPromotion: false,
  runtimeVersion: "v1.4.2",
});

test("Tsuzuki F7 persisted RUNNING is recoverable evidence, never factual LIVE or success", () => {
  const result = classifyLegacyInventoryEntry({
    entry: tsuzukiF7Entry,
    facts: tsuzukiF7Facts,
  });

  assert.equal(result.ok, true);
  assert.equal(result.disposition, "RECOVERABLE_IMPORT");
  assert.equal(result.blocksActivation, false);
  assert.equal(result.authorityClaim, false);
  assert.deepEqual(result.legacyEvidence, {
    persistedState: "RUNNING",
    runtimeVersion: "v1.4.2",
    ownerProcessProof: "ABSENT",
    survivingWorkspaces: 2,
    canonicalPromotion: false,
  });
  assert.equal(result.reconciliation.eligible, true);
  assert.equal(result.reconciliation.liveness, "UNKNOWN");
  assert.notEqual(result.reconciliation.liveness, "LIVE");
  assert.equal(result.reconciliation.successClaim, false);
  assert.equal(result.reconciliation.workspaceIdentity, "AMBIGUOUS");
  assert.equal(result.reconciliation.cleanupAuthorized, false);
  assert.equal(result.reconciliation.operationImportEligible, false);
  assert.equal(result.reconciliation.actionRequired, "RECONCILE_LEGACY_TRANSIENT_STATE");
});

test("F7 ambiguity remains explicit even though no canonical promotion was recorded", () => {
  const result = classifyLegacyInventoryEntry({
    entry: tsuzukiF7Entry,
    facts: tsuzukiF7Facts,
  });
  assert.equal(result.disposition, "RECOVERABLE_IMPORT");
  assert.equal(result.reconciliation.workspaceIdentity, "AMBIGUOUS");
  assert.equal(result.reconciliation.cleanupAuthorized, false);
  assert.equal(result.reconciliation.canonicalPromotionClaim, false);
});

test("same orphan shape on unsupported legacy runtime is blocked with actionable diagnostic", () => {
  const result = classifyLegacyInventoryEntry({
    entry: tsuzukiF7Entry,
    facts: { ...tsuzukiF7Facts, runtimeVersion: "v1.0.0" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.disposition, "UNSUPPORTED_BLOCKED");
  assert.equal(result.blocksActivation, true);
  assert.equal(result.authorityClaim, false);
  assert.equal(result.diagnostic.code, "LEGACY_RUNTIME_UNSUPPORTED");
  assert.equal(result.reconciliation.eligible, false);
});

function transientFixture({ path, category, schema, record, facts }) {
  const bytes = jsonBytes(record);
  const entry = {
    path,
    category,
    schema,
    version: 1,
    digest: digest(bytes),
    integrity: "PARSED",
    dispositionBasis: "TRANSIENT_STATE",
    private: false,
  };
  return {
    bytes,
    entry,
    facts,
    classification: classifyLegacyInventoryEntry({ entry, facts }),
  };
}

function migrationInput(workspace, fixture, commandId) {
  return {
    workspace,
    commandId,
    runtimeImage: "runtime-image-migration",
    instructionEpoch: 7,
    trustMode: "trusted",
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
  };
}

const nodeMajor = Number(process.versions.node.split(".")[0]);

async function withRealMigration(run) {
  const [{ mkdtemp, mkdir, rm }, { join }, { tmpdir }, { execFileSync }, registryModule, reconciliationModule] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
    import("node:os"),
    import("node:child_process"),
    import("../../v2/global/project-registry.mjs"),
    import("../../v2/global/reconciliation.mjs"),
  ]);
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-f7-migration-"));
  const workspace = join(root, "project");
  const home = join(root, "home");
  try {
    await mkdir(workspace, { recursive: true });
    execFileSync("git", ["init", workspace], { stdio: "ignore" });
    const registry = registryModule.createGlobalProjectRegistry({ home });
    try {
      await run({
        root,
        workspace,
        home,
        join,
        registry,
        createGlobalOperationReconciler: reconciliationModule.createGlobalOperationReconciler,
      });
    } finally {
      registry.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("migrated F7 orphan is visible in project status as UNKNOWN recovery work and can be explicitly abandoned", { skip: nodeMajor < 22 }, async () => {
  await withRealMigration(async ({ workspace, home, registry, createGlobalOperationReconciler }) => {
    const record = {
      schema: "orchestra.parallel-group-state.v1",
      group: { groupId: tsuzukiF7Facts.groupId },
      state: "RUNNING",
      memberArtifactIds: [],
      compositeArtifactId: null,
      createdAt: tsuzukiF7Facts.createdAt,
      updatedAt: tsuzukiF7Facts.updatedAt,
    };
    const fixture = transientFixture({
      path: tsuzukiF7Entry.path,
      category: tsuzukiF7Entry.category,
      schema: tsuzukiF7Entry.schema,
      record,
      facts: tsuzukiF7Facts,
    });
    const importer = createLegacyMigrationImporter({ projectRegistry: registry });
    const imported = await importer.apply(migrationInput(workspace, fixture, "f7-migration-command"));

    assert.equal(imported.ok, true);
    assert.equal(imported.code, "MIGRATION_TRANSIENT_IMPORT_APPLIED");
    assert.equal(imported.transient.length, 1);
    assert.equal(imported.transient[0].reconciliation.liveness, "UNKNOWN");
    assert.equal(imported.transient[0].operationId, null);
    assert.equal(imported.recoveryWork.state, "MIGRATION_RECOVERY_REQUIRED");
    assert.ok(imported.recoveryWork.blockers.some((value) => value.startsWith("MIGRATION_TRANSIENT_UNKNOWN:")));

    const reconciler = createGlobalOperationReconciler({
      state: registry.state,
      home,
      readProcessIdentity: async () => ({ status: "ABSENT" }),
      workspaceRecovery: {
        async inspect(workspaceRef) { return { workspaceRef, status: "UNKNOWN" }; },
        async cleanup() { throw new Error("cleanup must not run for ambiguous F7"); },
      },
    });
    const status = await reconciler.inspect({ projectId: imported.project.projectId });
    assert.equal(status.ok, true);
    assert.equal(status.work.workId, imported.recoveryWork.workId);
    assert.ok(status.work.blockers.some((value) => value.includes(fixture.entry.digest)));
    assert.deepEqual(status.operations, []);

    const abandoned = registry.state.work.abandonCurrent({
      projectId: imported.project.projectId,
      expectedWorkId: imported.recoveryWork.workId,
      expectedGeneration: imported.recoveryWork.generation,
      commandId: "f7-explicit-abandon",
      reason: "MIGRATION_TRANSIENT_EXPLICIT_ABANDON",
    });
    assert.equal(abandoned.ok, true);
    assert.equal(registry.state.work.current(imported.project.projectId), null);
  });
});

test("proven stale legacy operation becomes STALE_RECOVERABLE through factual v2 reconciliation, never imported factual LIVE", { skip: nodeMajor < 22 }, async () => {
  await withRealMigration(async ({ workspace, home, join, registry, createGlobalOperationReconciler }) => {
    const survivorRef = join(workspace, ".orchestra", "state", "delegation", "workspaces", "legacy-survivor");
    const facts = {
      persistedState: "RUNNING",
      runtimeVersion: "v1.4.2",
      ownerProcessProof: "ABSENT",
      survivingWorkspaces: 1,
      workspaceIdentityProven: true,
      survivingWorkspaceRef: survivorRef,
      canonicalPromotion: false,
      operationProvenanceComplete: true,
      operationKind: "LEGACY_DELEGATION",
      startedAt: "2026-10-16T15:00:00.000Z",
      heartbeatAt: "2026-10-16T15:00:10.000Z",
      deadlineAt: "2026-10-16T15:01:00.000Z",
      ownerProcess: { pid: 424242, startIdentity: "legacy-process-start" },
      ownerProofTokenHash: `sha256:${"a".repeat(64)}`,
    };
    const fixture = transientFixture({
      path: ".orchestra/state/delegations/legacy-operation.json",
      category: "TRANSIENT_LEGACY_STATE",
      schema: "orchestra.delegation-state.v1",
      record: { schema: "orchestra.delegation-state.v1", state: "RUNNING", facts },
      facts,
    });
    assert.equal(fixture.classification.reconciliation.operationImportEligible, true);
    assert.equal(fixture.classification.reconciliation.workspaceIdentity, "SINGLE_SURVIVOR_VERIFIED");
    assert.notEqual(fixture.classification.reconciliation.liveness, "LIVE");

    const importer = createLegacyMigrationImporter({ projectRegistry: registry });
    const imported = await importer.apply(migrationInput(workspace, fixture, "stale-operation-command"));
    assert.equal(imported.ok, true);
    assert.ok(imported.transient[0].operationId);

    const reconciler = createGlobalOperationReconciler({
      state: registry.state,
      home,
      now: () => "2026-10-17T12:00:00.000Z",
      readProcessIdentity: async () => ({ status: "ABSENT" }),
      workspaceRecovery: {
        async inspect(workspaceRef) { return { workspaceRef, status: "CLEAN" }; },
        async cleanup() {},
      },
    });
    const status = await reconciler.inspect({ projectId: imported.project.projectId });
    assert.equal(status.ok, true);
    assert.equal(status.operations.length, 1);
    assert.equal(status.operations[0].assessment.liveness, "STALE_RECOVERABLE");
    assert.equal(status.operations[0].recoveryAvailable, true);
    assert.equal(status.operations[0].operation.workspaceRef, survivorRef);
    assert.equal(status.project.workspace.canonicalRoot, workspace);

    const recovered = await reconciler.recover({
      projectId: imported.project.projectId,
      operationId: imported.transient[0].operationId,
      commandId: "recover-imported-stale-operation",
    });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.recovered, true);
  });
});

test("dirty proven survivor is preserved and routed to resolve-dirty semantics", { skip: nodeMajor < 22 }, async () => {
  await withRealMigration(async ({ workspace, home, join, registry, createGlobalOperationReconciler }) => {
    const survivorRef = join(workspace, ".orchestra", "state", "delegation", "workspaces", "dirty-survivor");
    const facts = {
      persistedState: "RUNNING",
      runtimeVersion: "v1.4.2",
      ownerProcessProof: "ABSENT",
      survivingWorkspaces: 1,
      workspaceIdentityProven: true,
      survivingWorkspaceRef: survivorRef,
      canonicalPromotion: false,
      operationProvenanceComplete: true,
      operationKind: "LEGACY_DELEGATION",
      startedAt: "2026-10-16T15:00:00.000Z",
      heartbeatAt: "2026-10-16T15:00:10.000Z",
      deadlineAt: "2026-10-16T15:01:00.000Z",
      ownerProcess: { pid: 424243, startIdentity: "legacy-dirty-process-start" },
      ownerProofTokenHash: `sha256:${"b".repeat(64)}`,
    };
    const fixture = transientFixture({
      path: ".orchestra/state/delegations/legacy-dirty-operation.json",
      category: "TRANSIENT_LEGACY_STATE",
      schema: "orchestra.delegation-state.v1",
      record: { schema: "orchestra.delegation-state.v1", state: "RUNNING", facts },
      facts,
    });

    const importer = createLegacyMigrationImporter({ projectRegistry: registry });
    const imported = await importer.apply(migrationInput(workspace, fixture, "dirty-operation-command"));
    assert.equal(imported.ok, true);
    let cleanupCalls = 0;
    const reconciler = createGlobalOperationReconciler({
      state: registry.state,
      home,
      now: () => "2026-10-17T12:00:00.000Z",
      readProcessIdentity: async () => ({ status: "ABSENT" }),
      workspaceRecovery: {
        async inspect(workspaceRef) { return { workspaceRef, status: "DIRTY" }; },
        async cleanup() { cleanupCalls += 1; },
      },
    });

    const recovery = await reconciler.recover({
      projectId: imported.project.projectId,
      operationId: imported.transient[0].operationId,
      commandId: "dirty-recovery-command",
    });
    assert.equal(recovery.ok, false);
    assert.equal(recovery.reason, "STALE_DIRTY");
    assert.equal(recovery.actionRequired, "RESOLVE_DIRTY_WORKSPACE");
    assert.equal(recovery.preserved, true);
    assert.equal(cleanupCalls, 0);

    const resolved = await reconciler.resolveDirty({
      projectId: imported.project.projectId,
      operationId: imported.transient[0].operationId,
      action: "PRESERVE",
      commandId: "dirty-preserve-command",
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.action, "PRESERVE");
    assert.equal(resolved.preserved, true);
    assert.equal(cleanupCalls, 0);
  });
});