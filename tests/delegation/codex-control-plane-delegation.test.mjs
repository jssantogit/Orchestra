import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCodexDelegationRequest,
  decideCodexCrossProviderRoute,
  executeCodexCrossProviderDelegation,
} from "../../runtimes/codex/.codex/astra-orchestra/cross-provider-delegation.mjs";
import { validateDelegationRequest } from "../../core/domain/delegation.mjs";

function packet() {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId: "task-second-opinion",
    candidateGeneration: 7,
    goal: "Review the candidate independently",
    direction: { change: "Report bounded findings", preserve: ["Do not mutate source"] },
    anchors: [{ file: "src/example.mjs", testHint: "node --test" }],
    scope: { allowedAreas: ["src/**", "tests/**"], forbidden: [".git/**"] },
    permissions: { discovery: "DIRECTED", tests: "READ_ONLY", sideEffects: [] },
    validation: ["node --test"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  };
}

function completedResult() {
  return {
    schema: "orchestra.delegation-result.v1",
    delegationId: "delegation-second-opinion",
    taskId: "task-second-opinion",
    sourceProvider: "codex",
    targetProvider: "antigravity",
    status: "COMPLETED",
    failureReason: null,
    summary: "Independent review completed",
    findings: [],
    evidenceRefs: [],
    execution: { exitCode: 0, durationMs: 10, timedOut: false, outputTruncated: false },
    workspace: {
      sourceRevision: "abcdef1234567890",
      initialFingerprint: "sha256:source",
      finalFingerprint: "sha256:source",
      dirty: false,
      dirtyFileCount: 0,
      cleaned: true,
      cleanupReason: null,
      recoverablePath: null,
    },
  };
}

test("Codex keeps normal implementation local and selects one independent provider for explicit second opinion", () => {
  const providerCapabilities = [
    { provider: "codex", available: true, independent: false },
    { provider: "antigravity", available: true, independent: true },
  ];

  assert.deepEqual(decideCodexCrossProviderRoute({
    logicalRole: "IMPLEMENTER",
    purpose: "MANUAL",
    independenceRequired: false,
    providerCapabilities,
  }), {
    mode: "LOCAL",
    targetProvider: "codex",
    reason: "SAME_PROVIDER_DEFAULT",
  });

  assert.deepEqual(decideCodexCrossProviderRoute({
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "SECOND_OPINION",
    independenceRequired: true,
    providerCapabilities,
    budget: { used: 0, limit: 1 },
  }), {
    mode: "CROSS_PROVIDER",
    targetProvider: "antigravity",
    reason: "SECOND_OPINION",
  });
});

test("Codex builds a canonical bounded request without delegating authority", () => {
  const request = buildCodexDelegationRequest({
    delegationId: "delegation-second-opinion",
    actorIdHash: "sha256:codex-control",
    targetProvider: "antigravity",
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "SECOND_OPINION",
    packet: packet(),
    sourceFingerprint: "sha256:source",
    sourceRevision: "abcdef1234567890",
  });

  assert.equal(validateDelegationRequest(request).valid, true);
  assert.equal(request.source.provider, "codex");
  assert.deepEqual(request.authority, {
    capabilities: ["LOCAL_READ", "PROCESS_EXEC"],
    mutation: "FORBIDDEN",
    network: "FORBIDDEN",
    mayDelegate: false,
  });
  assert.equal(request.limits.delegationDepth, 1);
  assert.equal("workLease" in request, false);
});

test("Codex returns broker result to CONTROL without self-acceptance", async () => {
  const request = buildCodexDelegationRequest({
    delegationId: "delegation-second-opinion",
    actorIdHash: "sha256:codex-control",
    targetProvider: "antigravity",
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "SECOND_OPINION",
    packet: packet(),
    sourceFingerprint: "sha256:source",
    sourceRevision: "abcdef1234567890",
  });
  let observed = null;

  const outcome = await executeCodexCrossProviderDelegation({
    request,
    repoRoot: "/repo",
    generation: 7,
    runCli: async (facts) => {
      observed = facts;
      return completedResult();
    },
  });

  assert.equal(observed.request, request);
  assert.equal(observed.repoRoot, "/repo");
  assert.equal(observed.generation, 7);
  assert.equal(outcome.controlReturned, true);
  assert.equal(outcome.accepted, false);
  assert.deepEqual(outcome.result, completedResult());
});
