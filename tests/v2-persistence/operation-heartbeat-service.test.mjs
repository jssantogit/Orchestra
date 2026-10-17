import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOperationHeartbeatService } from "../../v2/liveness/operation-heartbeat-service.mjs";
import { createRuntimeOwnerStore } from "../../v2/liveness/runtime-owner-store.mjs";
import { createReferenceState } from "../../v2/state/reference-state.mjs";

function tokenHash(token) {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

const OWNER_TOKEN = "owner-proof-secret";

function project() {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-heartbeat-proof",
    lineageId: "lineage-heartbeat-proof",
    workspace: { canonicalRoot: "C:/Projects/HeartbeatProof", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  };
}

function work() {
  return {
    schema: "orchestra.work-unit.v2",
    workId: "work-heartbeat-proof",
    projectId: "prj-heartbeat-proof",
    taskId: "task-heartbeat-proof",
    generation: 0,
    runtimeImage: "2.0.0",
    instructionEpoch: 1,
    state: "IMPLEMENTING",
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
  };
}

function operation() {
  return {
    schema: "orchestra.operation.v2",
    operationId: "op-heartbeat-proof",
    projectId: "prj-heartbeat-proof",
    workId: "work-heartbeat-proof",
    generation: 0,
    kind: "DIRECT_MUTATION",
    actorRef: "actor:heartbeat-proof",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T02:50:00.000Z",
    heartbeatAt: "2026-10-17T02:50:00.000Z",
    deadlineAt: "2026-10-17T03:00:00.000Z",
    runtimeOwnerRef: "owner:heartbeat-proof",
    workspaceRef: "workspace:canonical",
    resultRef: null,
  };
}

function owner(overrides = {}) {
  return {
    schema: "orchestra.runtime-owner.v2",
    runtimeOwnerId: "owner:heartbeat-proof",
    operationId: "op-heartbeat-proof",
    kind: "LOCAL_PROCESS",
    process: { pid: 999, startIdentity: "host-start:heartbeat-proof" },
    proof: { tokenHash: tokenHash(OWNER_TOKEN) },
    registeredAt: "2026-10-17T02:50:00.000Z",
    ...overrides,
  };
}

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "orchestra-v2-heartbeat-proof-"));
  const runtimeOwnerStore = createRuntimeOwnerStore({ rootDir });
  const state = createReferenceState();
  assert.equal(state.projects.register(project()).ok, true);
  assert.equal(state.work.startCurrent(work()).ok, true);
  assert.equal(state.operations.begin({ expectedGeneration: 0, operation: operation() }).ok, true);
  return {
    rootDir,
    runtimeOwnerStore,
    state,
    async cleanup() {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

test("official heartbeat verifies raw owner token against durable hash before mutation", async () => {
  const fx = await fixture();
  try {
    assert.equal((await fx.runtimeOwnerStore.register(owner())).ok, true);
    const service = createOperationHeartbeatService({
      state: fx.state,
      runtimeOwnerStore: createRuntimeOwnerStore({ rootDir: fx.rootDir }),
    });

    const result = await service.heartbeat({
      operationId: "op-heartbeat-proof",
      ownerToken: OWNER_TOKEN,
      heartbeatAt: "2026-10-17T02:51:00.000Z",
    });

    assert.equal(result.ok, true);
    assert.equal(result.operation.heartbeatAt, "2026-10-17T02:51:00.000Z");
  } finally {
    await fx.cleanup();
  }
});

test("wrong owner token fails closed and cannot refresh heartbeat", async () => {
  const fx = await fixture();
  try {
    assert.equal((await fx.runtimeOwnerStore.register(owner())).ok, true);
    const service = createOperationHeartbeatService({ state: fx.state, runtimeOwnerStore: fx.runtimeOwnerStore });

    const result = await service.heartbeat({
      operationId: "op-heartbeat-proof",
      ownerToken: "wrong-token",
      heartbeatAt: "2026-10-17T02:51:00.000Z",
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "OWNER_PROOF_MISMATCH");
    assert.equal(fx.state.operations.inspect("op-heartbeat-proof").heartbeatAt, "2026-10-17T02:50:00.000Z");
  } finally {
    await fx.cleanup();
  }
});

test("missing or unreadable Runtime Owner fails closed before heartbeat mutation", async () => {
  const fx = await fixture();
  try {
    const missing = createOperationHeartbeatService({ state: fx.state, runtimeOwnerStore: fx.runtimeOwnerStore });
    const missingResult = await missing.heartbeat({
      operationId: "op-heartbeat-proof",
      ownerToken: OWNER_TOKEN,
      heartbeatAt: "2026-10-17T02:51:00.000Z",
    });
    assert.equal(missingResult.reason, "RUNTIME_OWNER_MISSING");

    const broken = createOperationHeartbeatService({
      state: fx.state,
      runtimeOwnerStore: { async read() { throw new Error("store broken"); } },
    });
    const brokenResult = await broken.heartbeat({
      operationId: "op-heartbeat-proof",
      ownerToken: OWNER_TOKEN,
      heartbeatAt: "2026-10-17T02:51:00.000Z",
    });
    assert.equal(brokenResult.reason, "RUNTIME_OWNER_STORE_ERROR");
    assert.equal(fx.state.operations.inspect("op-heartbeat-proof").heartbeatAt, "2026-10-17T02:50:00.000Z");
  } finally {
    await fx.cleanup();
  }
});

test("Runtime Owner cannot authenticate heartbeat for a different Operation", async () => {
  const fx = await fixture();
  try {
    assert.equal((await fx.runtimeOwnerStore.register(owner({ operationId: "op-other" }))).ok, true);
    const service = createOperationHeartbeatService({ state: fx.state, runtimeOwnerStore: fx.runtimeOwnerStore });

    const result = await service.heartbeat({
      operationId: "op-heartbeat-proof",
      ownerToken: OWNER_TOKEN,
      heartbeatAt: "2026-10-17T02:51:00.000Z",
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "OWNER_OPERATION_MISMATCH");
    assert.equal(fx.state.operations.inspect("op-heartbeat-proof").heartbeatAt, "2026-10-17T02:50:00.000Z");
  } finally {
    await fx.cleanup();
  }
});
