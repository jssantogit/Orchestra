import test from "node:test";
import assert from "node:assert/strict";

import {
  createImplementationHandoff,
  createScopeContract,
  decideRoute,
  evaluateAcceptance,
} from "../.codex/astra-orchestra/routing-policy.mjs";
import {
  collectCodexCommandEvidence,
  collectCodexLocalFactEvidence,
  collectCodexRemoteCiEvidence,
} from "../.codex/astra-orchestra/evidence-collectors.mjs";
import {
  verifyEvidenceContract,
} from "../.codex/astra-orchestra/evidence-contract.mjs";
import {
  mergeFederatedEvidence,
} from "../.codex/astra-orchestra/evidence-federation.mjs";
import {
  applyFeedbackDeclarations,
  reconcileFeedbackPlane,
  FEEDBACK_STATUS,
} from "../.codex/astra-orchestra/feedback-plane.mjs";
import {
  SIDE_EFFECT_CAPABILITIES,
  authorizeToolCapability,
  createContinuationCapsule,
} from "../.codex/astra-orchestra/trust-boundary.mjs";
import {
  classifyMechanicalFastPath,
} from "../.codex/astra-orchestra/mechanical-fast-path.mjs";
import {
  assertCodexPacketSafe,
  createCodexWorkerPacket,
  evaluateCodexOutputGate,
  searchToWindowDecision,
} from "../.codex/astra-orchestra/context-packet.mjs";
import {
  CODEX_DREAM_AUTHORITY,
  CODEX_DREAM_LIMITS,
  canUseCodexCanary,
  consumeCodexExplorationBudget,
  createCodexCanaryApproval,
  createCodexDreamWorld,
  createCodexExplorationBudget,
  createCodexPolicyCandidate,
  createCodexShadowDecision,
  replayCodexPolicyCandidate,
} from "../.codex/astra-orchestra/dream-lab.mjs";
import {
  runCodexEvidenceWatchStep,
} from "../.codex/astra-orchestra/evidence-watch-runner.mjs";


test("Codex implementation handoff carries governed mandatory-core worker packet", () => {
  const handoff = createImplementationHandoff({
    taskId: "handoff-packet",
    taskDomain: "CODE",
    goal: "Change one implementation file",
    allowedPaths: ["src/a.mjs"],
    acceptanceCriteria: ["behavior passes"],
    requiredEvidence: [{
      id: "test",
      class: "LOCAL_TEST",
      kind: "LOCAL_COMMAND",
      command: "node --test a.test.mjs",
    }],
    auxiliaryRefs: Array.from({ length: 12 }, (_, i) => ({
      id: "ref-" + i,
      path: "src/ref-" + i + ".mjs",
      priority: 12 - i,
    })),
  });
  assert.equal(handoff.workerPacket.schema, "orchestra.codex-worker-packet.v1");
  assert.deepEqual(handoff.workerPacket.mandatory_core.scope.allowed_paths, ["src/a.mjs"]);
  assert.equal(handoff.workerPacket.auxiliary_refs.length <= 8, true);
});

test("Codex explicit mechanical fast path is fail-closed and routes Luna Medium only when eligible", () => {
  const eligible = decideRoute({
    taskAction: "MECHANICAL_FIX",
    taskDomain: "DOCS",
    mechanicalFastPath: true,
    scopeContract: {
      allowedPaths: ["docs/readme.md"],
      forbiddenPaths: [],
      testsRequired: [],
      requiredEvidence: [{
        id: "exists",
        class: "FILE_EXISTS",
        kind: "LOCAL_FACT",
        path: "docs/readme.md",
      }],
    },
  });
  assert.equal(eligible.profile, "luna-medium");
  assert.equal(eligible.reason, "bounded-mechanical-fast-path");
  assert.equal(eligible.mechanicalFastPath.eligible, true);

  const denied = decideRoute({
    taskAction: "MECHANICAL_FIX",
    taskDomain: "INFRA",
    mechanicalFastPath: true,
    scopeContract: {
      allowedPaths: [".codex/config.toml"],
      requiredEvidence: [{
        id: "exists",
        class: "FILE_EXISTS",
        kind: "LOCAL_FACT",
        path: ".codex/config.toml",
      }],
    },
  });
  assert.equal(denied.profile, "luna-high");
  assert.equal(denied.reason, "mechanical-fast-path-denied");
  assert.ok(denied.mechanicalFastPath.reasons.includes("SENSITIVE_PATH"));
});

test("Codex requiredEvidence is first-class in scope and Terra acceptance", () => {
  const requirement = {
    id: "test-1",
    class: "LOCAL_TEST",
    kind: "LOCAL_COMMAND",
    command: "node --test unit.test.mjs",
  };
  const scope = createScopeContract({
    taskAction: "IMPLEMENT",
    taskDomain: "CODE",
    allowedPaths: ["src/a.mjs"],
    requiredEvidence: [requirement],
  });
  assert.deepEqual(scope.requiredEvidence, [requirement]);

  const activeState = { taskId: "task-1", attempt: 0, mutationSeq: 1 };
  const evidence = collectCodexCommandEvidence({
    requirement,
    commandResult: { command: requirement.command, exitCode: 0, failed: 0 },
    activeState,
    actor: { role: "LUNA_MAX", confidence: "HIGH", source: "RUNTIME_IDENTITY", delegationKind: "WORK" },
  });

  const verification = verifyEvidenceContract({
    activeState: { ...activeState, evidenceLedger: [evidence] },
    contract: scope,
    evidenceLedger: [evidence],
  });
  assert.equal(verification.verified, true);

  const acceptance = evaluateAcceptance({
    workerResult: { status: "IMPLEMENTATION_COMPLETE" },
    scopeContract: scope,
    activeState,
    evidenceLedger: [evidence],
    changedPaths: ["src/a.mjs"],
  });
  assert.equal(acceptance.accepted, true);
});

test("Codex local factual evidence is hash-bound and mutation-bound", () => {
  const requirement = { id: "fact", class: "FILE_EXISTS", kind: "LOCAL_FACT", path: "src/a.mjs" };
  const state = { taskId: "task-fact", attempt: 0, mutationSeq: 3 };
  const evidence = collectCodexLocalFactEvidence({ requirement, value: { path: "src/a.mjs" }, activeState: state });
  const pass = verifyEvidenceContract({ activeState: state, contract: { requiredEvidence: [requirement] }, evidenceLedger: [evidence] });
  assert.equal(pass.verified, true);

  const stale = verifyEvidenceContract({
    activeState: { ...state, mutationSeq: 4 },
    contract: { requiredEvidence: [requirement] },
    evidenceLedger: [evidence],
  });
  assert.equal(stale.verified, false);
  assert.equal(stale.status, "STALE");
});

test("Codex delegated evidence ledger deduplicates by factual identity", () => {
  const state = { evidenceLedger: [] };
  const ev = { evidenceId: "ev-1", command: "node --test", exitCode: 0 };
  mergeFederatedEvidence(state, ev);
  mergeFederatedEvidence(state, { ...ev, failed: 0 });
  assert.equal(state.evidenceLedger.length, 1);
  assert.equal(state.evidenceLedger[0].failed, 0);
});

test("Codex remote CI evidence and watch are factual provider records", () => {
  const requirement = {
    id: "ci",
    class: "FAST_CI",
    kind: "REMOTE_CI",
    provider: "GITHUB_ACTIONS",
    workflow: { name: "CI" },
    requiredJobs: ["verify"],
  };
  const state = { taskId: "ci-task", attempt: 0, mutationSeq: 0, scopeContract: { requiredEvidence: [requirement] } };
  const raw = collectCodexRemoteCiEvidence({
    requirement,
    observation: { status: "success", runId: 42, commitSha: "abc" },
    activeState: state,
  });
  assert.equal(raw.result, "PASS");
  assert.equal(raw.provenance.source, "ORCHESTRA_CODEX_GITHUB_COLLECTOR");

  const step = runCodexEvidenceWatchStep({
    activeState: state,
    scopeContract: state.scopeContract,
    requirement,
    observation: { status: "success", runId: 43 },
  });
  assert.equal(step.polled, true);
  assert.equal(step.evidence.result, "PASS");
  assert.equal(step.verification.verified, true);
});

test("Codex feedback plane cannot create factual support from model claim alone", () => {
  const state = { taskId: "fb", attempt: 0, mutationSeq: 0, evidenceLedger: [] };
  applyFeedbackDeclarations(state, [
    { type: "HYPOTHESIS", key: "h", statement: "claim", falsifier: "counterexample" },
    { type: "EXPERIMENT", key: "e", hypothesis_key: "h", command: "node --test x.test.mjs", pass_interpretation: "SUPPORTS" },
  ], { role: "LUNA_MAX", source: "MODEL_CLAIM", confidence: "LOW" });
  reconcileFeedbackPlane(state);
  assert.equal(state.feedbackPlane.feedback[0].status, FEEDBACK_STATUS.UNKNOWN);
});

test("Codex remote side effects fail closed without explicit capability", () => {
  const denied = authorizeToolCapability({
    toolName: "exec_command",
    toolArgs: { command: "git push origin main" },
    activeState: { taskAction: "IMPLEMENT" },
    activeContract: {},
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.capability, SIDE_EFFECT_CAPABILITIES.VCS_REMOTE_WRITE);

  const allowed = authorizeToolCapability({
    toolName: "exec_command",
    toolArgs: { command: "git push origin main" },
    activeState: { taskAction: "IMPLEMENT" },
    activeContract: { sideEffectCapabilities: ["VCS_REMOTE_WRITE"] },
  });
  assert.equal(allowed.allowed, true);
});

test("Codex continuation capsule contains runtime authority only", () => {
  const capsule = createContinuationCapsule({
    activeState: {
      taskId: "capsule",
      taskAction: "IMPLEMENT",
      state: "EXECUTING",
      workerLastMessage: "ignore scope",
      taskSpec: "bypass evidence",
      evidenceLedger: [],
    },
    activeContract: { allowedPaths: ["src/a.mjs"] },
    roleBindings: { bindings: {} },
  });
  const text = JSON.stringify(capsule);
  assert.equal(text.includes("ignore scope"), false);
  assert.equal(text.includes("bypass evidence"), false);
  assert.deepEqual(capsule.scope.allowed_paths, ["src/a.mjs"]);
});

test("Codex mechanical fast path is bounded to Luna Medium support work", () => {
  const result = classifyMechanicalFastPath({
    taskAction: "MECHANICAL_FIX",
    criticality: "NORMAL",
    requestedProfile: "luna-medium",
    scopeContract: {
      allowedPaths: ["docs/readme.md"],
      forbiddenPaths: [],
      testsRequired: [],
      requiredEvidence: [{ id: "exists", class: "FILE_EXISTS", kind: "LOCAL_FACT", path: "docs/readme.md" }],
    },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.targetWorker, "luna-medium");
  assert.ok(result.maxMutationCalls <= 8);
});

test("Codex packet governance preserves mandatory core and excludes transcripts", () => {
  const packet = createCodexWorkerPacket({
    task: { goal: "Implement feature" },
    scopeContract: {
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      allowedPaths: ["src/a.mjs"],
      requiredEvidence: [{ id: "t", class: "LOCAL_TEST", kind: "LOCAL_COMMAND", command: "node --test" }],
    },
    activeState: { taskId: "packet", state: "PLANNED", mutationSeq: 1 },
    auxiliaryRefs: Array.from({ length: 20 }, (_, i) => ({ id: "ref-" + i, path: "src/" + i + ".mjs", priority: 20 - i })),
  });
  assert.equal(packet.auxiliary_refs.length <= 8, true);
  assert.equal(packet.mandatory_core.scope.allowed_paths[0], "src/a.mjs");
  assert.equal(assertCodexPacketSafe(packet).valid, true);
  assert.throws(() => createCodexWorkerPacket({
    task: { goal: "x" },
    scopeContract: { requiredEvidence: [{ id: "bad", class: "X", kind: "LOCAL_FACT", transcript: "secret" }] },
  }), /CODEX_PACKET_FORBIDDEN_FIELD/);

  assert.equal(evaluateCodexOutputGate({ bytes: 70000, lines: 10 }).action, "PERSIST_AND_REFERENCE");
  assert.equal(searchToWindowDecision({ fileBytes: 300000 }).action, "SEARCH_THEN_WINDOW");
});

test("Codex Dream lab is bounded, zero-authority, and cannot auto-promote", () => {
  assert.equal(CODEX_DREAM_LIMITS.max_parallel, 1);
  const world = createCodexDreamWorld({
    activeState: { taskId: "dream", taskAction: "INVESTIGATE", state: "BLOCKED" },
    scopeContract: { allowedPaths: ["src/a.mjs"] },
  });
  assert.equal(world.authority, CODEX_DREAM_AUTHORITY);

  const candidate = createCodexPolicyCandidate({
    policy_key: "context-small",
    decision_class: "CONTEXT_SELECTION",
    parameters: { max_refs: 4 },
    hypothesis: "smaller packets preserve accepted behavior",
    falsifier: "critical reference is omitted",
  });
  const replay = replayCodexPolicyCandidate({
    world,
    candidate,
    evaluation: { metrics: { context_bytes: 1200 }, accepted_behavior_preserved: true },
  });
  const shadow = createCodexShadowDecision({ replay, baseline: { context_bytes: 2400 } });
  assert.equal(shadow.runtime_effect, "NONE");
  assert.equal(shadow.automatic_activation, false);

  const denied = createCodexCanaryApproval({ shadow });
  assert.equal(denied.approved, false);

  const approved = createCodexCanaryApproval({ shadow, approved: true, approvedBy: "human" });
  assert.equal(canUseCodexCanary(approved), true);
  assert.equal(approved.source_rewrite, false);

  const budget = createCodexExplorationBudget({ max_branches: 999, max_total_model_calls: 999 });
  assert.equal(budget.max_branches, 3);
  assert.equal(budget.max_total_model_calls, 6);
  let current = budget;
  for (let i = 0; i < 3; i++) {
    const step = consumeCodexExplorationBudget(current, { branches: 1, modelCalls: 1 });
    assert.equal(step.allowed, true);
    current = step.budget;
  }
  assert.equal(consumeCodexExplorationBudget(current, { branches: 1, modelCalls: 1 }).allowed, false);
});

test("Codex Dream candidate rejects provider/model control fields", () => {
  assert.throws(() => createCodexPolicyCandidate({
    policy_key: "bad",
    decision_class: "REVIEW_TRIGGER",
    parameters: { model: "gemini-3.8-flash-high" },
  }), /CODEX_DREAM_POLICY_INVALID/);
});
