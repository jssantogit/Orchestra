import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCodexDelegationRequest,
  buildCodexImplementationDelegationRequest,
  decideCodexCrossProviderRoute,
  discardCodexDelegationArtifact,
  executeCodexCrossProviderDelegation,
  inspectCodexDelegationArtifact,
  promoteCodexDelegationArtifact,
} from "../../runtimes/codex/.codex/astra-orchestra/cross-provider-delegation.mjs";
import { validateDelegationRequest } from "../../core/domain/delegation.mjs";

function packet({ implementation = false } = {}) {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId: implementation ? "task-implementation" : "task-second-opinion",
    candidateGeneration: 7,
    goal: implementation ? "Implement the bounded change" : "Review the candidate independently",
    direction: {
      change: implementation ? "Modify the authorized source" : "Report bounded findings",
      preserve: ["CONTROL authority"],
    },
    anchors: [{ file: "src/example.mjs", testHint: "node --test" }],
    scope: { allowedAreas: ["src/**", "tests/**"], forbidden: [".git/**"] },
    permissions: {
      discovery: "DIRECTED",
      tests: implementation ? "MODIFY_AUTHORIZED_TARGETS" : "READ_ONLY",
      sideEffects: implementation ? ["WORKSPACE_EDIT"] : [],
    },
    validation: ["node --test"],
    failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
  };
}

function completedResult() {
  return {
    schema: "orchestra.delegation-result.v1",
    delegationId: "delegation-second-opinion",
    provider: "antigravity",
    logicalRole: "CRITICAL_REVIEWER",
    purpose: "SECOND_OPINION",
    status: "COMPLETED",
    summary: "Independent review completed",
    findings: [],
    evidenceRefs: [],
    execution: { exitCode: 0, durationMs: 10 },
    workspace: {
      initialFingerprint: "sha256:source",
      finalFingerprint: "sha256:source",
      dirty: false,
    },
  };
}

function completedImplementationResult() {
  return {
    schema: "orchestra.delegation-result.v2",
    delegationId: "delegation-implementation",
    provider: "antigravity",
    logicalRole: "IMPLEMENTER",
    purpose: "IMPLEMENTATION",
    status: "COMPLETED",
    summary: "Implementation completed",
    findings: [],
    evidenceRefs: [],
    execution: { exitCode: 0, durationMs: 10 },
    workspace: {
      sourceRevision: "abcdef1234567890",
      sourceFingerprint: "sha256:source",
      delegatedPath: "/tmp/review/workspace",
      changedPaths: ["src/example.mjs"],
      dirty: true,
    },
    artifact: {
      artifactId: "delegation-implementation",
      patchSha256: "sha256:patch",
      mutationDigest: "sha256:mutation",
      changedPaths: ["src/example.mjs"],
      state: "READY_FOR_REVIEW",
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

test("Codex crosses to AGY for implementation only under explicit CONTROL intent", () => {
  const providerCapabilities = [
    { provider: "codex", available: true, independent: false },
    { provider: "antigravity", available: true, independent: true, capabilities: { implementation: true } },
  ];

  assert.deepEqual(decideCodexCrossProviderRoute({
    logicalRole: "IMPLEMENTER",
    purpose: "IMPLEMENTATION",
    explicitCrossProvider: false,
    providerCapabilities,
  }), {
    mode: "LOCAL",
    targetProvider: "codex",
    reason: "SAME_PROVIDER_DEFAULT",
  });
  assert.deepEqual(decideCodexCrossProviderRoute({
    logicalRole: "IMPLEMENTER",
    purpose: "IMPLEMENTATION",
    explicitCrossProvider: true,
    providerCapabilities,
  }), {
    mode: "CROSS_PROVIDER",
    targetProvider: "antigravity",
    reason: "IMPLEMENTATION",
  });
  assert.deepEqual(decideCodexCrossProviderRoute({
    logicalRole: "IMPLEMENTER",
    purpose: "IMPLEMENTATION",
    explicitCrossProvider: true,
    providerCapabilities: [
      { provider: "codex", available: true, independent: false },
      { provider: "antigravity", available: false, independent: true },
    ],
  }), {
    mode: "NONE",
    targetProvider: null,
    reason: "PROVIDER_UNAVAILABLE",
  });
});

test("Codex builds canonical v2 implementation request with scoped workspace authority", () => {
  const request = buildCodexImplementationDelegationRequest({
    delegationId: "delegation-implementation",
    actorIdHash: "sha256:codex-control",
    targetProvider: "antigravity",
    packet: packet({ implementation: true }),
    sourceFingerprint: "sha256:source",
    sourceRevision: "abcdef1234567890",
    mutationScope: {
      allowedPaths: ["src/**", "tests/**"],
      forbiddenPaths: ["docs/**"],
    },
  });

  assert.equal(validateDelegationRequest(request).valid, true);
  assert.equal(request.schema, "orchestra.delegation-request.v2");
  assert.deepEqual(request.target, { provider: "antigravity", logicalRole: "IMPLEMENTER" });
  assert.equal(request.purpose, "IMPLEMENTATION");
  assert.deepEqual(request.authority, {
    capabilities: ["LOCAL_READ", "PROCESS_EXEC", "WORKSPACE_EDIT"],
    mutation: "WORKSPACE_ONLY",
    network: "FORBIDDEN",
    mayDelegate: false,
  });
  assert.deepEqual(request.workspace.mutationScope, {
    allowedPaths: ["src/**", "tests/**"],
    forbiddenPaths: ["docs/**"],
  });
  assert.equal(request.workspace.isolation, "EPHEMERAL_CLONE");
  assert.equal("workLease" in request, false);
});

test("Codex v2 execution returns sealed artifact claim to CONTROL and rejects result-version mismatch", async () => {
  const request = buildCodexImplementationDelegationRequest({
    delegationId: "delegation-implementation",
    actorIdHash: "sha256:codex-control",
    targetProvider: "antigravity",
    packet: packet({ implementation: true }),
    sourceFingerprint: "sha256:source",
    sourceRevision: "abcdef1234567890",
    mutationScope: { allowedPaths: ["src/**"], forbiddenPaths: [] },
  });

  const outcome = await executeCodexCrossProviderDelegation({
    request,
    repoRoot: "/repo",
    generation: 7,
    runCli: async () => completedImplementationResult(),
  });
  assert.equal(outcome.controlReturned, true);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.claimOnly, true);
  assert.equal(outcome.result.artifact.state, "READY_FOR_REVIEW");

  await assert.rejects(
    executeCodexCrossProviderDelegation({
      request,
      repoRoot: "/repo",
      generation: 7,
      runCli: async () => ({ ...completedResult(), delegationId: request.delegationId, logicalRole: "IMPLEMENTER", purpose: "IMPLEMENTATION" }),
    }),
    /ORCHESTRA_CODEX_DELEGATION_RESULT_MISMATCH/,
  );
});

test("Codex artifact wrappers invoke neutral artifact actions with exact CONTROL provenance", async () => {
  const observed = [];
  const runArtifactCli = async (facts) => {
    observed.push(facts);
    if (facts.action === "inspect") return { integrity: { valid: true, reason: null }, reviewPath: "/tmp/review" };
    if (facts.action === "promote") return { promoted: true, reason: null, changedPaths: ["src/example.mjs"] };
    return { discarded: true, reason: null };
  };

  const inspected = await inspectCodexDelegationArtifact({
    repoRoot: "/repo",
    artifactId: "artifact-1",
    runArtifactCli,
  });
  const promoted = await promoteCodexDelegationArtifact({
    repoRoot: "/repo",
    artifactId: "artifact-1",
    generation: 7,
    actorIdHash: "sha256:codex-control",
    runArtifactCli,
  });
  const discarded = await discardCodexDelegationArtifact({
    repoRoot: "/repo",
    artifactId: "artifact-2",
    generation: 7,
    actorIdHash: "sha256:codex-control",
    runArtifactCli,
  });

  assert.deepEqual(observed, [
    { action: "inspect", repoRoot: "/repo", artifactId: "artifact-1" },
    {
      action: "promote",
      repoRoot: "/repo",
      artifactId: "artifact-1",
      generation: 7,
      sourceProvider: "codex",
      actorIdHash: "sha256:codex-control",
    },
    {
      action: "discard",
      repoRoot: "/repo",
      artifactId: "artifact-2",
      generation: 7,
      sourceProvider: "codex",
      actorIdHash: "sha256:codex-control",
    },
  ]);
  assert.equal(inspected.integrity.valid, true);
  assert.equal(promoted.promoted, true);
  assert.equal(discarded.discarded, true);
  assert.equal("accepted" in promoted, false);
});
