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
      provider: "codex", projectId: "prj-a", correlationHash: "sha256:correlation",
      operationId: "op-a", workId: "work-a", generation: 1, actorIdHash: "sha256:actor",
    };
    const state = {
      projects: { inspect: () => structuredClone(project) },
      work: { read: () => ({ workId: "work-a", generation: 1, runtimeImage: "sha256:runtime-image" }) },
      operations: { inspect: () => structuredClone(op) },
      operationCorrelations: { get: () => structuredClone(correlation) },
    };
    const first = createNativeRsiObservationStore({ dbPath, state, now: () => "2026-10-20T12:00:01.000Z" });
    assert.equal(first.recordDecision({ operationId: "op-a", providerFamily: "codex", correlationHash: "sha256:correlation" }).ok, true);
    assert.deepEqual(first.listEligible(), []);
    assert.equal(first.recordDecision({ operationId: "op-a", providerFamily: "codex", correlationHash: "sha256:correlation" }).replayed, true);
    first.close();
    op.workflowState = "SUCCEEDED";
    op.liveness = "TERMINAL";
    op.resultRef = "provider-result:succeeded:sha256:correlation";
    const reopened = createNativeRsiObservationStore({ dbPath, state, now: () => "2026-10-20T12:00:02.000Z" });
    assert.equal(reopened.recordTerminal({ operationId: "op-a" }).ok, true);
    const eligible = reopened.listEligible();
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].phase, "TRAIN");
    assert.deepEqual(eligible[0].decision.immutableRoutes, ["DIRECT_WORK"]);
    assert.equal(eligible[0].decision.selectedRoute, "DIRECT_WORK");
    assert.equal(eligible[0].source.lineageId, "lineage-a");
    assert.equal(eligible[0].outcome.durationMs, 2000);
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
      provider: "codex", projectId: "prj-b", correlationHash: "sha256:correlation",
      operationId: "op-b", workId: "work-b", generation: 0, actorIdHash: "sha256:actor",
    };
    const state = {
      projects: { inspect: () => ({ projectId: "prj-b", lineageId: "lineage-b", runtime: { pinnedImage: "image" } }) },
      work: { read: () => ({ workId: "work-b", generation: 0, runtimeImage: "image" }) },
      operations: { inspect: () => structuredClone(operation) },
      operationCorrelations: { get: () => structuredClone(correlation) },
    };
    const store = createNativeRsiObservationStore({ dbPath: join(home, "native.db"), state, now: () => "2026-10-20T12:00:01.000Z" });
    assert.equal(store.recordDecision({ operationId: "op-b", providerFamily: "codex", correlationHash: "sha256:correlation" }).ok, true);
    operation.workflowState = "UNKNOWN";
    operation.liveness = "TERMINAL";
    operation.resultRef = "provider-result:unknown:sha256:correlation";
    assert.equal(store.recordTerminal({ operationId: "op-b" }).ok, false);
    assert.deepEqual(store.listEligible(), []);
    operation.workflowState = "SUCCEEDED";
    operation.resultRef = "provider-result:succeeded:WRONG";
    assert.equal(store.recordTerminal({ operationId: "op-b" }).ok, false);
    assert.deepEqual(store.listEligible(), []);
    store.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});
