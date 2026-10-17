import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOperationLivenessService } from "../../v2/liveness/operation-liveness-service.mjs";
import { createRuntimeOwnerStore } from "../../v2/liveness/runtime-owner-store.mjs";

const NOW = "2026-10-17T02:40:00.000Z";

function operation(overrides = {}) {
  return {
    schema: "orchestra.operation.v2",
    operationId: "op-service",
    projectId: "prj-service",
    workId: "work-service",
    generation: 1,
    kind: "DIRECT_MUTATION",
    actorRef: "actor:service",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T02:39:00.000Z",
    heartbeatAt: "2026-10-17T02:39:50.000Z",
    deadlineAt: "2026-10-17T02:45:00.000Z",
    runtimeOwnerRef: "owner:service",
    workspaceRef: "workspace:canonical",
    resultRef: null,
    ...overrides,
  };
}

function owner() {
  return {
    schema: "orchestra.runtime-owner.v2",
    runtimeOwnerId: "owner:service",
    operationId: "op-service",
    kind: "LOCAL_PROCESS",
    process: { pid: 1234, startIdentity: "host-start:service" },
    proof: { tokenHash: `sha256:${"e".repeat(64)}` },
    registeredAt: "2026-10-17T02:39:00.000Z",
  };
}

function matchingProbe() {
  return {
    async observe(runtimeOwner) {
      return {
        schema: "orchestra.owner-observation.v2",
        runtimeOwnerId: runtimeOwner.runtimeOwnerId,
        observedAt: NOW,
        status: "MATCH",
        observedProcessIdentity: runtimeOwner.process.startIdentity,
      };
    },
  };
}

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "orchestra-v2-liveness-service-"));
  const runtimeOwnerStore = createRuntimeOwnerStore({ rootDir });
  return {
    rootDir,
    runtimeOwnerStore,
    async cleanup() {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

test("service composes durable owner + probe + policy into factual LIVE", async () => {
  const fx = await fixture();
  try {
    assert.equal((await fx.runtimeOwnerStore.register(owner())).ok, true);
    const service = createOperationLivenessService({
      runtimeOwnerStore: fx.runtimeOwnerStore,
      ownerProbe: matchingProbe(),
      now: () => NOW,
    });

    const result = await service.assess(operation());
    assert.equal(result.liveness, "LIVE");
    assert.equal(result.reason, "OWNER_MATCH_HEARTBEAT_FRESH");
  } finally {
    await fx.cleanup();
  }
});

test("missing durable Runtime Owner is UNKNOWN and does not call the probe", async () => {
  let probeCalls = 0;
  const service = createOperationLivenessService({
    runtimeOwnerStore: { async read() { return null; } },
    ownerProbe: { async observe() { probeCalls += 1; throw new Error("must not run"); } },
    now: () => NOW,
  });

  const result = await service.assess(operation());
  assert.equal(result.liveness, "UNKNOWN");
  assert.equal(result.reason, "RUNTIME_OWNER_MISSING");
  assert.equal(probeCalls, 0);
});

test("Runtime Owner store failure is converted to explicit UNKNOWN", async () => {
  const service = createOperationLivenessService({
    runtimeOwnerStore: { async read() { throw new Error("corrupt store"); } },
    ownerProbe: matchingProbe(),
    now: () => NOW,
  });

  const result = await service.assess(operation());
  assert.equal(result.liveness, "UNKNOWN");
  assert.equal(result.reason, "RUNTIME_OWNER_STORE_ERROR");
});

test("owner probe failure is converted to explicit UNKNOWN", async () => {
  const service = createOperationLivenessService({
    runtimeOwnerStore: { async read() { return owner(); } },
    ownerProbe: { async observe() { throw new Error("probe failed"); } },
    now: () => NOW,
  });

  const result = await service.assess(operation());
  assert.equal(result.liveness, "UNKNOWN");
  assert.equal(result.reason, "OWNER_PROBE_FAILED");
});

test("terminal Operation does not require owner storage or host probing", async () => {
  let reads = 0;
  let probes = 0;
  const service = createOperationLivenessService({
    runtimeOwnerStore: { async read() { reads += 1; return null; } },
    ownerProbe: { async observe() { probes += 1; return null; } },
    now: () => NOW,
  });

  const result = await service.assess(operation({
    workflowState: "COMPLETED",
    liveness: "TERMINAL",
    resultRef: "result:done",
  }));
  assert.equal(result.liveness, "TERMINAL");
  assert.equal(result.reason, "PERSISTED_TERMINAL");
  assert.equal(reads, 0);
  assert.equal(probes, 0);
});
