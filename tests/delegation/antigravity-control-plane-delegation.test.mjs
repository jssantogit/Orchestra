import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAntigravityDelegationRequest,
  buildAntigravityImplementationDelegationRequest,
  decideAntigravityCrossProviderRoute,
  discardAntigravityDelegationArtifact,
  executeAntigravityCrossProviderDelegation,
  inspectAntigravityDelegationArtifact,
  promoteAntigravityDelegationArtifact,
} from "../../runtimes/antigravity/.agents/skills/orchestra/cross-provider-delegation.mjs";
import { validateDelegationRequest } from "../../core/domain/delegation.mjs";
import { classifyCommandCapability } from "../../runtimes/antigravity/.agents/skills/orchestra/trust-boundary.mjs";

function packet({ implementation = false } = {}) {
  return {
    schema: "orchestra.implementation-packet.v1",
    taskId: implementation ? "task-implementation" : "task-critical-review",
    candidateGeneration: 9,
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

function completedImplementationResult() {
  return {
    schema: "orchestra.delegation-result.v2",
    delegationId: "delegation-implementation",
    provider: "codex",
    logicalRole: "IMPLEMENTER",
    purpose: "IMPLEMENTATION",
    status: "COMPLETED",
    summary: "Implementation completed",
    findings: [],
    evidenceRefs: [],
    execution: { exitCode: 0, durationMs: 12 },
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

test("Antigravity crosses to Codex for implementation only under explicit CONTROL intent", () => {
  const capabilities = [
    { provider: "antigravity", available: true, independent: false },
    { provider: "codex", available: true, independent: true },
  ];

  assert.deepEqual(decideAntigravityCrossProviderRoute({
    logicalRole: "IMPLEMENTER",
    purpose: "IMPLEMENTATION",
    explicitCrossProvider: false,
    providerCapabilities: capabilities,
  }), {
    mode: "LOCAL",
    targetProvider: "antigravity",
    reason: "SAME_PROVIDER_DEFAULT",
  });
  assert.deepEqual(decideAntigravityCrossProviderRoute({
    logicalRole: "IMPLEMENTER",
    purpose: "IMPLEMENTATION",
    explicitCrossProvider: true,
    providerCapabilities: capabilities,
  }), {
    mode: "CROSS_PROVIDER",
    targetProvider: "codex",
    reason: "IMPLEMENTATION",
  });
  assert.deepEqual(decideAntigravityCrossProviderRoute({
    logicalRole: "IMPLEMENTER",
    purpose: "IMPLEMENTATION",
    explicitCrossProvider: true,
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

test("Antigravity builds canonical v2 implementation request with scoped workspace authority", () => {
  const request = buildAntigravityImplementationDelegationRequest({
    delegationId: "delegation-implementation",
    actorIdHash: "sha256:agy-control",
    targetProvider: "codex",
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
  assert.deepEqual(request.target, { provider: "codex", logicalRole: "IMPLEMENTER" });
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

test("Antigravity v2 execution returns sealed artifact claim to CONTROL and rejects result-version mismatch", async () => {
  const request = buildAntigravityImplementationDelegationRequest({
    delegationId: "delegation-implementation",
    actorIdHash: "sha256:agy-control",
    targetProvider: "codex",
    packet: packet({ implementation: true }),
    sourceFingerprint: "sha256:source",
    sourceRevision: "abcdef1234567890",
    mutationScope: { allowedPaths: ["src/**"], forbiddenPaths: [] },
  });

  const outcome = await executeAntigravityCrossProviderDelegation({
    request,
    repoRoot: "/repo",
    generation: 9,
    runCli: async () => completedImplementationResult(),
  });
  assert.equal(outcome.controlReturned, true);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.claimOnly, true);
  assert.equal(outcome.result.artifact.state, "READY_FOR_REVIEW");

  await assert.rejects(
    executeAntigravityCrossProviderDelegation({
      request,
      repoRoot: "/repo",
      generation: 9,
      runCli: async () => ({ ...completedResult(), delegationId: request.delegationId, logicalRole: "IMPLEMENTER", purpose: "IMPLEMENTATION" }),
    }),
    /ORCHESTRA_ANTIGRAVITY_DELEGATION_RESULT_MISMATCH/,
  );
});

test("Antigravity artifact wrappers invoke neutral artifact actions with exact CONTROL provenance", async () => {
  const observed = [];
  const runArtifactCli = async (facts) => {
    observed.push(facts);
    if (facts.action === "inspect") return { integrity: { valid: true, reason: null }, reviewPath: "/tmp/review" };
    if (facts.action === "promote") return { promoted: true, reason: null, changedPaths: ["src/example.mjs"] };
    return { discarded: true, reason: null };
  };

  const inspected = await inspectAntigravityDelegationArtifact({
    repoRoot: "/repo",
    artifactId: "artifact-1",
    runArtifactCli,
  });
  const promoted = await promoteAntigravityDelegationArtifact({
    repoRoot: "/repo",
    artifactId: "artifact-1",
    generation: 9,
    actorIdHash: "sha256:agy-control",
    runArtifactCli,
  });
  const discarded = await discardAntigravityDelegationArtifact({
    repoRoot: "/repo",
    artifactId: "artifact-2",
    generation: 9,
    actorIdHash: "sha256:agy-control",
    runArtifactCli,
  });

  assert.deepEqual(observed, [
    { action: "inspect", repoRoot: "/repo", artifactId: "artifact-1" },
    {
      action: "promote",
      repoRoot: "/repo",
      artifactId: "artifact-1",
      generation: 9,
      sourceProvider: "antigravity",
      actorIdHash: "sha256:agy-control",
    },
    {
      action: "discard",
      repoRoot: "/repo",
      artifactId: "artifact-2",
      generation: 9,
      sourceProvider: "antigravity",
      actorIdHash: "sha256:agy-control",
    },
  ]);
  assert.equal(inspected.integrity.valid, true);
  assert.equal(promoted.promoted, true);
  assert.equal(discarded.discarded, true);
  assert.equal("accepted" in promoted, false);
});
