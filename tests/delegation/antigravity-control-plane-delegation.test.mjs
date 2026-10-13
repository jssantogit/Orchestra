import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAntigravityDelegationRequest,
  decideAntigravityCrossProviderRoute,
  executeAntigravityCrossProviderDelegation,
} from "../../runtimes/antigravity/.agents/skills/orchestra/cross-provider-delegation.mjs";
import { validateDelegationRequest } from "../../core/domain/delegation.mjs";
import { classifyCommandCapability } from "../../runtimes/antigravity/.agents/skills/orchestra/trust-boundary.mjs";

function packet() {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId: "task-critical-review",
    candidateGeneration: 9,
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
    delegationId: "delegation-critical-review",
    provider: "codex",
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    status: "COMPLETED",
    summary: "Independent review completed",
    findings: [],
    evidenceRefs: [],
    execution: { exitCode: 0, durationMs: 12 },
    workspace: { initialFingerprint: "sha256:source", finalFingerprint: "sha256:source", dirty: false },
  };
}

test("Antigravity routes only independent critical review across providers and respects one-shot budget", () => {
  const capabilities = [
    { provider: "antigravity", available: true, independent: false },
    { provider: "codex", available: true, independent: true },
  ];

  assert.deepEqual(decideAntigravityCrossProviderRoute({
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    independenceRequired: true,
    providerCapabilities: capabilities,
    budget: { used: 0, limit: 1 },
  }), {
    mode: "CROSS_PROVIDER",
    targetProvider: "codex",
    reason: "INDEPENDENT_REVIEW",
  });

  assert.deepEqual(decideAntigravityCrossProviderRoute({
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    independenceRequired: true,
    providerCapabilities: capabilities,
    budget: { used: 1, limit: 1 },
  }), {
    mode: "NONE",
    targetProvider: null,
    reason: "BUDGET_EXHAUSTED",
  });

  assert.equal(decideAntigravityCrossProviderRoute({
    logicalRole: "INVESTIGATOR",
    purpose: "MANUAL",
    independenceRequired: false,
    providerCapabilities: capabilities,
  }).mode, "LOCAL");
});

test("Antigravity returns provider unavailable instead of falling back to local critical review", () => {
  assert.deepEqual(decideAntigravityCrossProviderRoute({
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    independenceRequired: true,
    providerCapabilities: [
      { provider: "antigravity", available: true, independent: false },
      { provider: "codex", available: false, independent: true },
    ],
  }), {
    mode: "NONE",
    targetProvider: null,
    reason: "PROVIDER_UNAVAILABLE",
  });
});

test("Antigravity builds canonical claim-only delegation and returns result to CONTROL", async () => {
  const request = buildAntigravityDelegationRequest({
    delegationId: "delegation-critical-review",
    actorIdHash: "sha256:agy-control",
    targetProvider: "codex",
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "INDEPENDENT_REVIEW",
    packet: packet(),
    sourceFingerprint: "sha256:source",
    sourceRevision: "abcdef1234567890",
  });
  assert.equal(validateDelegationRequest(request).valid, true);
  assert.equal(request.source.provider, "antigravity");
  assert.equal(request.authority.mutation, "FORBIDDEN");
  assert.equal(request.authority.network, "FORBIDDEN");
  assert.equal(request.authority.mayDelegate, false);

  const outcome = await executeAntigravityCrossProviderDelegation({
    request,
    repoRoot: "/repo",
    generation: 9,
    runCli: async () => completedResult(),
  });
  assert.equal(outcome.controlReturned, true);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.claimOnly, true);
});

test("neutral delegation CLI remains bounded process execution and does not grant remote-write authority", () => {
  assert.deepEqual(classifyCommandCapability(
    "node .orchestra/runtime/delegation/runtime/delegation/cli.mjs --request /tmp/request.json --repo-root . --generation 1",
  ), {
    capability: "PROCESS_EXEC",
    reason: "local_process",
  });
  assert.equal(classifyCommandCapability("git push origin main").capability, "VCS_REMOTE_WRITE");
  assert.equal(classifyCommandCapability("curl https://example.com").capability, "NETWORK_READ");
});
