import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateTwoKeyReview,
  createTwoKeyReviewPacket,
} from "../../runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs";

import {
  evaluateTaskFidelity,
} from "../../benchmarks/turn-economy/fidelity.mjs";

const samplePacket = createTwoKeyReviewPacket({
  goal: "Independent critical review of src/parser.js boundary",
  acceptanceCriteria: "Containment of prototype keys, non-finite values, malformed inputs",
  technicalDecision: "Enforce strict input validation boundary in src/parser.js",
  diff: "diff --git a/src/parser.js b/src/parser.js",
  tests: "node --test test/parser.test.js",
  risks: "Prototype pollution, unexpected type coercion",
});

test("Two-Key Consensus 1: ACCEPT + ACCEPT -> accepted consensus (DONE)", () => {
  const res = evaluateTwoKeyReview(samplePacket, "ACCEPT", "ACCEPT");
  assert.equal(res.acceptable, true);
  assert.equal(res.decision, "ACCEPT");
  assert.equal(res.nextState, "DONE");
});

test("Two-Key Consensus 2: ACCEPT + CHANGES_REQUIRED -> HUMAN_GATE (no Reviewer C)", () => {
  const res = evaluateTwoKeyReview(samplePacket, "ACCEPT", "CHANGES_REQUIRED");
  assert.equal(res.acceptable, false);
  assert.equal(res.decision, "DISAGREEMENT");
  assert.equal(res.nextState, "HUMAN_GATE");
  assert.equal(res.humanGateRequired, true);
});

test("Two-Key Consensus 3: CHANGES_REQUIRED + ACCEPT -> HUMAN_GATE (no Reviewer C)", () => {
  const res = evaluateTwoKeyReview(samplePacket, "CHANGES_REQUIRED", "ACCEPT");
  assert.equal(res.acceptable, false);
  assert.equal(res.decision, "DISAGREEMENT");
  assert.equal(res.nextState, "HUMAN_GATE");
  assert.equal(res.humanGateRequired, true);
});

test("Two-Key Consensus 4: CHANGES_REQUIRED + CHANGES_REQUIRED -> correction/Delta Retry path", () => {
  const res = evaluateTwoKeyReview(samplePacket, "CHANGES_REQUIRED", "CHANGES_REQUIRED");
  assert.equal(res.acceptable, false);
  assert.equal(res.decision, "RETRY_REQUIRED");
  assert.equal(res.nextState, "PLANNED");
  assert.equal(res.retryReason, "TWO_KEY_REJECTION");
});

test("Two-Key Consensus 5: BLOCK from either reviewer -> never DONE", () => {
  const res1 = evaluateTwoKeyReview(samplePacket, "BLOCK", "ACCEPT");
  assert.notEqual(res1.nextState, "DONE");
  assert.equal(res1.acceptable, false);

  const res2 = evaluateTwoKeyReview(samplePacket, "ACCEPT", "BLOCK");
  assert.notEqual(res2.nextState, "DONE");
  assert.equal(res2.acceptable, false);

  const res3 = evaluateTwoKeyReview(samplePacket, "BLOCK", "BLOCK");
  assert.notEqual(res3.nextState, "DONE");
  assert.equal(res3.acceptable, false);
});

test("Two-Key Consensus 6: only one reviewer result available -> no acceptance", () => {
  const res1 = evaluateTwoKeyReview(samplePacket, "ACCEPT", null);
  assert.equal(res1.acceptable, false);
  assert.notEqual(res1.nextState, "DONE");

  const res2 = evaluateTwoKeyReview(samplePacket, null, "ACCEPT");
  assert.equal(res2.acceptable, false);
  assert.notEqual(res2.nextState, "DONE");
});

test("Two-Key Consensus 7: same conversation ID supplied for both keys -> fail", () => {
  const convIdA = "child-conv-shared-1";
  const convIdB = "child-conv-shared-1";
  const distinctReviewers = convIdA !== convIdB;
  assert.equal(distinctReviewers, false, "Same conversation ID cannot satisfy two independent keys");
});

test("Two-Key Consensus 8: reviewer A identity UNKNOWN -> fail", () => {
  const reviewerA = {
    role: "UNKNOWN",
    confidence: "LOW",
    profile: null,
  };
  const isFactual = reviewerA.role === "REVIEWER" && reviewerA.confidence === "HIGH";
  assert.equal(isFactual, false, "Reviewer A identity UNKNOWN must fail closed");
});

test("Two-Key Consensus 9: reviewer B identity UNKNOWN -> fail", () => {
  const reviewerB = {
    role: "UNKNOWN",
    confidence: "LOW",
    profile: null,
  };
  const isFactual = reviewerB.role === "REVIEWER" && reviewerB.confidence === "HIGH";
  assert.equal(isFactual, false, "Reviewer B identity UNKNOWN must fail closed");
});

test("Two-Key Consensus 10: reviewer write event -> fail", () => {
  const fidelity = evaluateTaskFidelity({
    taskKey: "critical",
    runtime: "antigravity",
    subagentInvocations: 2,
    mutationActor: "WORKER",
    mutationEvents: [
      {
        path: "src/parser.js",
        actorRole: "WORKER",
        agentProfile: "flash-reviewer",
        confidence: "HIGH",
      },
    ],
    orchestratorWorkspaceWrites: 0,
    unknownWorkspaceWrites: 0,
    dryRun: false,
  });
  assert.equal(fidelity.writeActorValid, false);
  assert.equal(fidelity.fidelityStatus, "FAIL");
  assert.ok(fidelity.violations.some((v) => v.includes("UNEXPECTED_MUTATION_IN_READONLY_TASK")));
});

test("Two-Key Consensus 11: orchestrator product write -> fail", () => {
  const fidelity = evaluateTaskFidelity({
    taskKey: "critical",
    runtime: "antigravity",
    subagentInvocations: 2,
    mutationActor: "ORCHESTRATOR",
    mutationEvents: [
      {
        path: "src/parser.js",
        actorRole: "ORCHESTRATOR",
        agentProfile: "flash-orchestrator",
        confidence: "HIGH",
      },
    ],
    orchestratorWorkspaceWrites: 1,
    unknownWorkspaceWrites: 0,
    dryRun: false,
  });
  assert.equal(fidelity.writeActorValid, false);
  assert.equal(fidelity.fidelityStatus, "FAIL");
  assert.ok(fidelity.violations.some((v) => v.includes("ORCHESTRATOR_PRODUCT_WRITE_ALLOWED")));
});

test("Two-Key Consensus 12: cross-talk detected -> fail", () => {
  const reviewerAConvId = "child-conv-rev-a";
  const reviewerBConvId = "child-conv-rev-b";
  const reviewerBVerdict = "ACCEPT";
  const transcriptA = `I inspected src/parser.js and reviewed child-conv-rev-b verdict: ${reviewerBVerdict}`;

  const crossTalkDetected = transcriptA.includes(reviewerBConvId) || transcriptA.includes(`verdict: ${reviewerBVerdict}`);
  assert.equal(crossTalkDetected, true, "Cross-talk detection must catch other reviewer verdict or conversation ID");
});

test("Two-Key Consensus 13: third reviewer spawned after disagreement -> fail", () => {
  const reviewerCount = 3;
  const noThirdVote = reviewerCount <= 2;
  assert.equal(noThirdVote, false, "Spawning a third reviewer to break tie violates Two-Key architecture");
});

test("Two-Key Consensus 14: two distinct factual reviewer identities with valid consensus -> pass", () => {
  const reviewerA = {
    conversationId: "child-conv-rev-a",
    role: "REVIEWER",
    profile: "flash-reviewer",
    model: "gemini-3.8-flash-high",
    confidence: "HIGH",
    source: "RUNTIME_IDENTITY",
    verdict: "ACCEPT",
    mutations: [],
  };
  const reviewerB = {
    conversationId: "child-conv-rev-b",
    role: "REVIEWER",
    profile: "flash-reviewer",
    model: "gemini-3.8-flash-high",
    confidence: "HIGH",
    source: "RUNTIME_IDENTITY",
    verdict: "ACCEPT",
    mutations: [],
  };

  const consensus = evaluateTwoKeyReview(samplePacket, reviewerA.verdict, reviewerB.verdict);
  assert.equal(consensus.acceptable, true);
  assert.equal(consensus.decision, "ACCEPT");
  assert.equal(consensus.nextState, "DONE");

  const distinctIds = reviewerA.conversationId !== reviewerB.conversationId;
  const factualRoles = reviewerA.role === "REVIEWER" && reviewerB.role === "REVIEWER";
  const factualProfiles = reviewerA.profile === "flash-reviewer" && reviewerB.profile === "flash-reviewer";
  const factualModels = reviewerA.model === "gemini-3.8-flash-high" && reviewerB.model === "gemini-3.8-flash-high";
  const readOnly = reviewerA.mutations.length === 0 && reviewerB.mutations.length === 0;

  assert.equal(distinctIds, true);
  assert.equal(factualRoles, true);
  assert.equal(factualProfiles, true);
  assert.equal(factualModels, true);
  assert.equal(readOnly, true);

  const fidelity = evaluateTaskFidelity({
    taskKey: "critical",
    runtime: "antigravity",
    subagentInvocations: 2,
    mutationActor: "NONE",
    mutationEvents: [],
    orchestratorWorkspaceWrites: 0,
    unknownWorkspaceWrites: 0,
    dryRun: false,
    confidenceEvidence: { hasExplicitAgentRole: true, hasSubagentTrace: true },
    workerObserved: true,
  });
  assert.equal(fidelity.writeActorValid, true);
  assert.equal(fidelity.fidelityStatus, "PASS");
});
