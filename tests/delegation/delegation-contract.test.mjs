import test from "node:test";
import assert from "node:assert/strict";

import { validateSchema } from "../../core/schema/validator.mjs";

function implementationPacket() {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId: "delegation-contract",
    candidateGeneration: 1,
    goal: "review one bounded candidate",
    direction: { change: "inspect the candidate", preserve: ["public API"] },
    anchors: [{ file: "src/example.mjs" }],
    scope: { allowedAreas: ["src/**"], forbidden: ["secrets/**"] },
    permissions: { discovery: "DIRECTED", tests: "READ_ONLY", sideEffects: ["LOCAL_TEST"] },
    validation: ["focused test"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  };
}

function request() {
  return {
    schema: "orchestra.delegation-request.v1",
    delegationId: "delegation-1",
    taskId: "delegation-contract",
    source: { provider: "provider-a", actorIdHash: "sha256:actor" },
    target: { provider: "provider-b", logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    packet: implementationPacket(),
    authority: {
      capabilities: ["LOCAL_READ", "PROCESS_EXEC"],
      mutation: "FORBIDDEN",
      network: "FORBIDDEN",
      mayDelegate: false,
    },
    workspace: {
      sourceFingerprint: "sha256:workspace",
      sourceRevision: "abc1234",
      isolation: "EPHEMERAL_WORKTREE",
    },
    limits: { timeoutMs: 30000, maxOutputBytes: 32768, delegationDepth: 1 },
  };
}

function result() {
  return {
    schema: "orchestra.delegation-result.v1",
    delegationId: "delegation-1",
    provider: "provider-b",
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    status: "COMPLETED",
    summary: "No blocking issue found.",
    findings: [],
    evidenceRefs: ["test:focused"],
    execution: { exitCode: 0, durationMs: 10 },
    workspace: { initialFingerprint: "sha256:a", finalFingerprint: "sha256:b", dirty: false },
  };
}

test("delegation request accepts only bounded read/process-exec authority", () => {
  assert.equal(validateSchema("delegation-request.v1.schema.json", request()).valid, true);

  for (const mutate of [
    (value) => { value.authority.capabilities.push("WORKSPACE_EDIT"); },
    (value) => { value.authority.mutation = "ALLOWED"; },
    (value) => { value.authority.network = "ALLOWED"; },
    (value) => { value.authority.mayDelegate = true; },
    (value) => { value.limits.delegationDepth = 2; },
    (value) => { value.workspace.isolation = "CANONICAL_WORKTREE"; },
  ]) {
    const value = request();
    mutate(value);
    assert.equal(validateSchema("delegation-request.v1.schema.json", value).valid, false);
  }
});

test("delegation result stays bounded and distinct from canonical evidence/acceptance", () => {
  assert.equal(validateSchema("delegation-result.v1.schema.json", result()).valid, true);

  for (const forbidden of ["transcript", "reasoning", "prompt", "stdout", "stderr", "accepted", "candidate"]) {
    const value = { ...result(), [forbidden]: "forbidden" };
    assert.equal(validateSchema("delegation-result.v1.schema.json", value).valid, false, forbidden);
  }

  const failed = result();
  failed.status = "FAILED";
  failed.reason = "EXECUTION_FAILED";
  failed.execution.exitCode = 2;
  assert.equal(validateSchema("delegation-result.v1.schema.json", failed).valid, true);
});
