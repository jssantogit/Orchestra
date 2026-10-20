import test from "node:test";
import assert from "node:assert/strict";

const supported = Number(process.versions.node.split(".")[0]) >= 22;

test("native RSI persists factual decision before allow and correlates it with terminal operation across reopen", { skip: !supported }, async () => {
  const [{ createNativeRsiObservationStore }, { mkdtemp, rm }, { join }, { tmpdir }] = await Promise.all([
    import("../../v2/persistence/sqlite/sqlite-rsi-native.mjs"),
    import("node:fs/promises"), import("node:path"), import("node:os"),
  ]);
  const home = await mkdtemp(join(tmpdir(), "orchestra-rsi-native-"));
  try {
    const dbPath = join(home, "native.db");
    const project = {
      projectId: "prj-a", lineageId: "lineage-a",
      runtime: { pinnedImage: "sha256:runtime-image", instructionEpoch: 3 },
    };
    const op = {
      operationId: "op-a", projectId: "prj-a", workId: "work-a", generation: 1,
      kind: "DIRECT_MUTATION", capabilities: ["WORKSPACE_EDIT"], actorRef: "sha256:actor",
      workflowState: "RUNNING", liveness: "LIVE",
      startedAt: "2026-10-20T12:00:00.000Z", resultRef: null,
    };
    const correlation = {
      provider: "codex", projectId: "prj-a", correlationHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      operationId: "op-a", workId: "work-a", generation: 1, actorIdHash: "sha256:actor",
    };
    const state = {
      projects: { inspect: () => structuredClone(project) },
      work: { read: () => ({ workId: "work-a", generation: 1, runtimeImage: "sha256:runtime-image" }) },
      operations: { inspect: () => structuredClone(op) },
      operationCorrelations: { get: () => structuredClone(correlation) },
    };
    const first = createNativeRsiObservationStore({ dbPath, state, now: () => "2026-10-20T12:00:01.000Z" });
    assert.equal(first.recordDecision({ operationId: "op-a", providerFamily: "codex", correlationHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }).ok, true);
    assert.deepEqual(first.listEligible(), []);
    assert.equal(first.recordDecision({ operationId: "op-a", providerFamily: "codex", correlationHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }).replayed, true);
    first.close();
    op.workflowState = "SUCCEEDED";
    op.liveness = "TERMINAL";
    op.resultRef = "provider-result:succeeded:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const reopened = createNativeRsiObservationStore({ dbPath, state, now: () => "2026-10-20T12:00:02.000Z" });
    assert.equal(reopened.recordTerminal({ operationId: "op-a" }).ok, true);
    const eligible = reopened.listEligible();
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].phase, "TRAIN");
    assert.deepEqual(eligible[0].decision.immutableRoutes, ["DIRECT_WORK"]);
    assert.equal(eligible[0].decision.selectedRoute, "DIRECT_WORK");
    assert.equal(eligible[0].source.lineageId, "lineage-a");
    assert.equal(eligible[0].outcome.durationMs, 2000);
    assert.equal(Object.hasOwn(eligible[0].outcome, "retryCount"), false, "unknown native retries must never default to zero");
    assert.equal(reopened.recordTerminal({ operationId: "op-a" }).replayed, true);
    reopened.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("native RSI does not learn UNKNOWN and fails closed on corrupted terminal provenance", { skip: !supported }, async () => {
  const [{ createNativeRsiObservationStore }, { mkdtemp, rm }, { join }, { tmpdir }] = await Promise.all([
    import("../../v2/persistence/sqlite/sqlite-rsi-native.mjs"),
    import("node:fs/promises"), import("node:path"), import("node:os"),
  ]);
  const home = await mkdtemp(join(tmpdir(), "orchestra-rsi-unknown-"));
  try {
    const operation = {
      operationId: "op-b", projectId: "prj-b", workId: "work-b", generation: 0,
      kind: "DIRECT_MUTATION", capabilities: ["WORKSPACE_EDIT"], actorRef: "sha256:actor",
      workflowState: "RUNNING", liveness: "LIVE",
      startedAt: "2026-10-20T12:00:00.000Z", resultRef: null,
    };
    const correlation = {
      provider: "codex", projectId: "prj-b", correlationHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      operationId: "op-b", workId: "work-b", generation: 0, actorIdHash: "sha256:actor",
    };
    const state = {
      projects: { inspect: () => ({ projectId: "prj-b", lineageId: "lineage-b", runtime: { pinnedImage: "image" } }) },
      work: { read: () => ({ workId: "work-b", generation: 0, runtimeImage: "image" }) },
      operations: { inspect: () => structuredClone(operation) },
      operationCorrelations: { get: () => structuredClone(correlation) },
    };
    const store = createNativeRsiObservationStore({ dbPath: join(home, "native.db"), state, now: () => "2026-10-20T12:00:01.000Z" });
    assert.equal(store.recordDecision({ operationId: "op-b", providerFamily: "codex", correlationHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }).ok, true);
    operation.workflowState = "UNKNOWN";
    operation.liveness = "TERMINAL";
    operation.resultRef = "provider-result:unknown:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    assert.equal(store.recordTerminal({ operationId: "op-b" }).ok, false);
    assert.deepEqual(store.listEligible(), []);
    operation.workflowState = "SUCCEEDED";
    operation.resultRef = "provider-result:succeeded:WRONG";
    assert.equal(store.recordTerminal({ operationId: "op-b" }).ok, false);
    assert.deepEqual(store.listEligible(), []);
    store.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("global SQLite state mounts the native journal on real persisted Project/Work/Operation and survives reopen", { skip: !supported }, async () => {
  const [{ createSqliteState }, { mkdtemp, rm }, { join }, { tmpdir }] = await Promise.all([
    import("../../v2/persistence/sqlite/sqlite-state.mjs"),
    import("node:fs/promises"), import("node:path"), import("node:os"),
  ]);
  const root = await mkdtemp(join(tmpdir(), "orchestra-rsi-global-"));
  const dbPath = join(root, "state.db");
  try {
    const state = createSqliteState({ dbPath });
    const project = {
      schema: "orchestra.project.v2", projectId: "prj-native", lineageId: "lineage-native",
      workspace: { canonicalRoot: join(root, "project"), vcs: "git" },
      runtime: { pinnedImage: "native-image", instructionEpoch: 0 },
      trust: { mode: "trusted" },
    };
    assert.equal(state.projects.register(project).ok, true);
    const work = {
      schema: "orchestra.work-unit.v2", workId: "work-native", projectId: project.projectId,
      taskId: "task-native", generation: 0, runtimeImage: "native-image",
      instructionEpoch: 0, state: "INTAKE",
      scopeRef: null, directionRef: null, candidateRef: null,
      evidenceRefs: [], blockers: [], continuationRef: null,
    };
    assert.equal(state.work.startCurrent(work).ok, true);
    const at = new Date().toISOString();
    const operation = {
      schema: "orchestra.operation.v2", operationId: "op-native", projectId: project.projectId,
      workId: work.workId, generation: 0, kind: "DIRECT_MUTATION",
      actorRef: "sha256:" + "c".repeat(64), capabilities: ["WORKSPACE_EDIT"],
      workflowState: "RUNNING", liveness: "LIVE", startedAt: at, heartbeatAt: at,
      deadlineAt: new Date(Date.parse(at) + 60000).toISOString(),
      runtimeOwnerRef: "provider-owner:op-native",
      workspaceRef: project.workspace.canonicalRoot, resultRef: null,
    };
    assert.equal(state.operations.begin({ expectedGeneration: 0, operation }).ok, true);
    const hash = "sha256:" + "b".repeat(64);
    assert.equal(state.operationCorrelations.put({
      provider: "codex", projectId: project.projectId, correlationHash: hash,
      operationId: operation.operationId, workId: work.workId,
      generation: 0, actorIdHash: operation.actorRef,
    }).ok, true);
    assert.equal(state.nativeRsi.recordDecision({
      operationId: operation.operationId, providerFamily: "codex", correlationHash: hash,
    }).ok, true);
    state.close();
    const reopened = createSqliteState({ dbPath });
    const terminal = reopened.operations.terminalize({
      operationId: operation.operationId, workflowState: "SUCCEEDED",
      resultRef: `provider-result:succeeded:${hash}`, expectedHeartbeatAt: operation.heartbeatAt,
    });
    assert.equal(terminal.ok, true, JSON.stringify(terminal));
    assert.equal(reopened.nativeRsi.recordTerminal({ operationId: operation.operationId }).ok, true);
    assert.equal(reopened.nativeRsi.listEligible().length, 1);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
