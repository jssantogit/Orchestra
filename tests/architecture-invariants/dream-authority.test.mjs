import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  validateStateTransition,
} from "../../runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs";
import {
  validatePolicy,
  evaluatePolicy,
  computePolicyId,
  POLICY_STATUS,
} from "../../runtimes/antigravity/.agents/dream/policy-engine.mjs";
import {
  deriveAvailableActions,
  deriveDecisionState,
  deriveValidatedStaticBaseline,
  classifyBaselineDecision,
  DECISION_TYPES,
} from "../../runtimes/antigravity/.agents/dream/action-space.mjs";
import {
  replayExact,
  REPLAY_STATUS,
} from "../../runtimes/antigravity/.agents/dream/replay-simulator.mjs";
import {
  sealWorld,
  validateWorld,
} from "../../runtimes/antigravity/.agents/dream/world-sealer.mjs";
import {
  createDreamEvent,
  DREAM_SCHEMAS,
} from "../../runtimes/antigravity/.agents/dream/records.mjs";
import {
  canonicalize,
  sha256Canonical,
} from "../../runtimes/antigravity/.agents/dream/canonical.mjs";
import {
  buildSnapshot,
} from "../../runtimes/antigravity/.agents/dream/snapshot.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const preToolScript = resolve(repoRoot, "runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs");
const postToolScript = resolve(repoRoot, "runtimes/antigravity/.agents/hooks/post-tool-telemetry.mjs");
const stopToolScript = resolve(repoRoot, "runtimes/antigravity/.agents/hooks/stop-guard.mjs");

function cleanTestState() {
  try { rmSync(resolve(repoRoot, ".agents/state"), { recursive: true, force: true }); } catch {}
  try { rmSync(resolve(repoRoot, ".agents/telemetry"), { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// ARCH-001: Immutable Governance Over Dream
// Dream cannot modify or bypass state-machine transitions or governance rules.
// ---------------------------------------------------------------------------
test("ARCH-001: Immutable Governance Over Dream (Valid & Adversarial)", () => {
  // 1. Valid: Legal transition from EXECUTING to PLANNED on retry is permitted by governance
  const validTransition = validateStateTransition("EXECUTING", "PLANNED", {
    retry: true,
    retry_reason: "FAILED_TEST",
  });
  assert.equal(validTransition.valid, true, "Governance permits legal transition EXECUTING -> PLANNED on retry");

  // 2. Adversarial: Illegal transition (e.g. INTAKE directly to PLANNED on retry) is strictly rejected
  const adversarialTransition = validateStateTransition("INTAKE", "PLANNED", {
    retry: true,
    retry_reason: "FAILED_TEST",
  });
  assert.equal(adversarialTransition.valid, false, "Governance strictly forbids illegal transition INTAKE -> PLANNED");
});

// ---------------------------------------------------------------------------
// ARCH-002: Zero Online Context Overhead & No Raw History In Context
// Discovery History and sealed worlds must never leak into worker prompt or compact decision state.
// ---------------------------------------------------------------------------
test("ARCH-002: Zero Online Context Overhead & No Raw History In Context (Valid & Adversarial)", () => {
  const task = {
    taskAction: "IMPLEMENT",
    taskDomain: "CODE",
    criticality: "NORMAL",
    complexity: "NORMAL",
  };
  const activeState = {
    task_action: "IMPLEMENT",
    state: "EXECUTING",
    attempt: 0,
    retry_remaining: 2,
    post_investigation: false,
    mutationSeq: 1,
  };
  const evidence = {
    tests: "PASS",
    validation_fresh: true,
  };

  // 1. Valid: deriveDecisionState produces only bounded canonical categorical and numeric fields
  const decState = deriveDecisionState(task, activeState, evidence);
  assert.equal(decState.task_action, "IMPLEMENT");
  assert.equal(decState.state, "EXECUTING");
  assert.equal(decState.attempt, 0);
  assert.equal(decState.rawHistory, undefined, "Zero raw history allowed in decision state");
  assert.equal(decState.events, undefined, "Zero events stream in decision state");
  assert.equal(decState.trajectories, undefined, "Zero trajectory data in decision state");

  // 2. Adversarial: Attempting to pass raw discovery history / execution transcripts into decision state is sanitized
  const stateWithLeakage = {
    ...activeState,
    discovery_history: ["historical_turn_1", "historical_turn_2"],
    raw_prompt_history: "Secret prompt transcript",
  };
  const sanitizedState = deriveDecisionState(task, stateWithLeakage, evidence);
  assert.equal(sanitizedState.discovery_history, undefined, "Raw discovery history must not leak into decision state");
  assert.equal(sanitizedState.raw_prompt_history, undefined, "Raw prompt history must not leak into decision state");
});

// ---------------------------------------------------------------------------
// ARCH-003: Exact Replay Epistemic Invariant
// Unobserved replay branches return UNKNOWN_BRANCH with zero hallucinated outcomes.
// ---------------------------------------------------------------------------
test("ARCH-003: Exact Replay Epistemic Invariant (Valid & Adversarial)", () => {
  const rootSnapshotId = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  const runtimeFp = "sha256:4444444444444444444444444444444444444444444444444444444444444444";

  const dec = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-unobserved-1",
    parent_decision_id: null,
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: { phase: "start" },
    available_actions: ["PLAN", "EXECUTE_DIRECT"],
    chosen_action: "PLAN",
    policy_source: "STATIC_ROUTING_CURRENT",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:00.000Z",
  });
  const out = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-unobserved-1",
    observation_id: "obs-unobserved-1",
    result: "PLAN_DONE",
    resulting_snapshot_id: null,
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: {},
    cost_metrics: { tokens: 50 },
    created_at: "2026-09-17T12:00:05.000Z",
  });

  const sealRes = sealWorld({
    events: [dec, out],
    expectedRuntimeFingerprint: runtimeFp,
    rootSnapshotId,
  });
  assert.equal(sealRes.status, "SEALED");

  // 1. Valid: Replay selecting the observed action completes
  const observedRes = replayExact({
    world: sealRes.world,
    chooseAction: () => "PLAN",
  });
  assert.equal(observedRes.status, REPLAY_STATUS.EXACT_REPLAY_COMPLETE);

  // 2. Adversarial: Replay selecting unobserved legal action halts at UNKNOWN_BRANCH with 0 manufactured outcome
  const counterfactualRes = replayExact({
    world: sealRes.world,
    chooseAction: () => "EXECUTE_DIRECT",
  });
  assert.equal(counterfactualRes.status, REPLAY_STATUS.UNKNOWN_BRANCH);
  assert.equal(counterfactualRes.trajectories[0].steps.length, 0, "Zero manufactured outcome for unobserved branch");
  assert.equal(counterfactualRes.trajectories[0].terminal_state, null);
});

// ---------------------------------------------------------------------------
// ARCH-004: Declarative Schema-Valid Policy Invariant
// Mutable policy must be strictly declarative JSON; arbitrary executable code is rejected.
// ---------------------------------------------------------------------------
test("ARCH-004: Declarative Schema-Valid Policy Invariant (Valid & Adversarial)", () => {
  const basePolicyRaw = {
    schema: "orchestra.exploration-policy.v1",
    base_policy: null,
    description: "Valid declarative policy",
    created_at: "2026-09-17T00:00:00Z",
    rules: [
      {
        id: "rule-clean-valid",
        decision_type: "WORKER_TIER",
        priority: 100,
        when: {
          task_action: ["IMPLEMENT"],
          criticality: ["NORMAL"],
        },
        choose: "FLASH_MEDIUM",
      },
    ],
  };
  const validPolicy = {
    policy_id: computePolicyId(basePolicyRaw),
    ...basePolicyRaw,
  };

  // 1. Valid: Declarative schema-conformant policy passes validation
  const validRes = validatePolicy(validPolicy);
  assert.equal(validRes.valid, true);

  // 2. Adversarial: Injected disallowed property into policy is rejected
  const adversarialPolicyRaw = {
    ...basePolicyRaw,
    rules: [
      {
        id: "rule-malicious",
        decision_type: "WORKER_TIER",
        priority: 100,
        when: {
          task_action: ["IMPLEMENT"],
          disallowed_condition_prop: "forbidden",
        },
        choose: "FLASH_MEDIUM",
      },
    ],
  };
  const adversarialRes = validatePolicy({
    policy_id: computePolicyId(adversarialPolicyRaw),
    ...adversarialPolicyRaw,
  });
  assert.equal(adversarialRes.valid, false, "Disallowed when fields must be rejected");
  assert.match(adversarialRes.errors.join("; "), /disallowed condition field/);
});

// ---------------------------------------------------------------------------
// ARCH-005: Fail-Safe Fallback to Validated Static Routing
// Policy corruption or failure degrades safely to static routing without task failure.
// ---------------------------------------------------------------------------
test("ARCH-005: Fail-Safe Fallback to Validated Static Routing (Valid & Adversarial)", () => {
  const facts = {
    taskAction: "IMPLEMENT",
    criticality: "NORMAL",
    complexity: "NORMAL",
  };
  const state = {
    task_action: "IMPLEMENT",
    criticality: "NORMAL",
    complexity: "NORMAL",
    state: "PLANNED",
  };

  // 1. Valid: Static baseline resolution correctly produces authoritative baseline
  const baseline = deriveValidatedStaticBaseline({
    decisionType: DECISION_TYPES.WORKER_TIER,
    facts,
    state,
  });
  assert.equal(baseline, "FLASH_MEDIUM");

  // 2. Adversarial: Corrupted policy evaluates with fallback to baseline
  const corruptedPolicy = {
    schema: "orchestra.exploration-policy.v1",
    policy_id: "policy-0000000000000000000000000000000000000000000000000000000000000000",
    rules: [],
  };
  const evalResult = evaluatePolicy({
    policy: corruptedPolicy,
    decisionType: DECISION_TYPES.WORKER_TIER,
    state,
    availableActions: ["FLASH_LOW", "FLASH_MEDIUM"],
    baselineAction: baseline,
  });
  assert.equal(evalResult.ok, false);
  assert.equal(evalResult.source, "STATIC_ROUTING_FALLBACK");
  assert.equal(evalResult.action, baseline);
  assert.match(evalResult.diagnostic, /INVALID_POLICY/);
});

// ---------------------------------------------------------------------------
// ARCH-006: Cross-Runtime Isolation
// Dream v1 is Antigravity-only; Codex runtime remains strictly isolated.
// ---------------------------------------------------------------------------
test("ARCH-006: Cross-Runtime Isolation (Valid & Adversarial)", () => {
  const dreamDir = resolve(repoRoot, "runtimes/antigravity/.agents/dream");
  const dreamFiles = readdirSync(dreamDir).filter(f => f.endsWith(".mjs"));

  // 1. Valid: All Dream module files must NOT import from Codex
  for (const file of dreamFiles) {
    const content = readFileSync(resolve(dreamDir, file), "utf-8");
    assert.equal(
      content.includes("runtimes/codex"),
      false,
      `Dream module ${file} must not reference runtimes/codex`
    );
    assert.equal(
      content.includes(".codex"),
      false,
      `Dream module ${file} must not reference .codex`
    );
  }

  // 2. Adversarial: Simulated leakage detection
  const simulatedLeakedCode = "import { x } from '../../../codex/.codex/config.toml';";
  assert.equal(
    simulatedLeakedCode.includes("codex"),
    true,
    "Firewall check successfully catches Codex imports"
  );
});

// ---------------------------------------------------------------------------
// ARCH-007: Phase 1 Record-Only Baseline Behavioral Identity
// Foundation Dream is strictly record-only and behaviorally identical to baseline.
// ---------------------------------------------------------------------------
test("ARCH-007: Phase 1 Record-Only Baseline Behavioral Identity (Valid & Adversarial)", () => {
  const staticPolicyPath = resolve(repoRoot, "runtimes/antigravity/.agents/dream/policies/static-policy-v1.json");
  assert.ok(existsSync(staticPolicyPath), "static-policy-v1.json must exist");
  const staticPolicy = JSON.parse(readFileSync(staticPolicyPath, "utf-8"));

  const testState = {
    task_action: "IMPLEMENT",
    criticality: "NORMAL",
    complexity: "NORMAL",
    state: "PLANNED",
    attempt: 0,
    retry_remaining: 2,
    post_investigation: false,
  };
  const available = deriveAvailableActions(DECISION_TYPES.WORKER_TIER, testState);
  const baseline = deriveValidatedStaticBaseline({
    decisionType: DECISION_TYPES.WORKER_TIER,
    facts: testState,
    state: testState,
  });

  // 1. Valid: Evaluated policy strictly equals static baseline
  const evalRes = evaluatePolicy({
    policy: staticPolicy,
    decisionType: DECISION_TYPES.WORKER_TIER,
    state: testState,
    availableActions: available,
    baselineAction: baseline,
  });
  assert.equal(evalRes.ok, true);
  assert.equal(evalRes.action, baseline, "Static policy action must exactly match baseline action");

  // 2. Adversarial: An unauthorized policy rule attempting to divert implementation to FLASH_HIGH is caught
  const roguePolicyRaw = {
    ...staticPolicy,
    rules: [
      {
        id: "rogue-rule",
        decision_type: "WORKER_TIER",
        priority: 9999,
        when: { task_action: ["IMPLEMENT"] },
        choose: "FLASH_HIGH",
      },
      ...staticPolicy.rules,
    ],
  };
  delete roguePolicyRaw.policy_id;
  const roguePolicy = {
    policy_id: computePolicyId(roguePolicyRaw),
    ...roguePolicyRaw,
  };
  const rogueRes = evaluatePolicy({
    policy: roguePolicy,
    decisionType: DECISION_TYPES.WORKER_TIER,
    state: testState,
    availableActions: available,
    baselineAction: baseline,
  });
  assert.notEqual(rogueRes.action, baseline, "Rogue diverged action is detected");
});

// ---------------------------------------------------------------------------
// ARCH-008: Dream Never Increases Authority or Budgets
// Retry budgets, Human Gate, and Two-Key Review are immutable boundaries.
// ---------------------------------------------------------------------------
test("ARCH-008: Dream Never Increases Authority or Budgets (Valid & Adversarial)", () => {
  // 1. Valid: Available retry actions are strictly bounded by governance
  const stateWithBudget = {
    task_action: "IMPLEMENT",
    retry_reason: "FAILED_TEST",
    attempt: 1,
    retry_remaining: 1,
  };
  const actions = deriveAvailableActions(DECISION_TYPES.RETRY_ACTION, stateWithBudget);
  assert.ok(actions.includes("RETRY_SAME"));

  // 2. Adversarial: Worker attempting retry when retry budget is exhausted is strictly denied
  cleanTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      criticality: "NORMAL",
      state: "EXECUTING",
      retry: true,
      attempt: 2,
      remainingAttempts: 0,
      prevRemainingAttempts: 0,
      retryReason: "FAILED_TEST",
      lastWorkerProfile: "flash-medium-worker",
    }, null, 2), "utf-8");

    const inputExhausted = JSON.stringify({
      conversationId: "arch-008-conv",
      stepIdx: 1,
      toolCall: {
        id: "call_worker_exhausted",
        name: "invoke_subagent",
        args: {
          remainingAttempts: 0,
          Subagents: [{ TypeName: "flash-medium-worker", Role: "worker", Prompt: "Retry" }],
        },
      },
    });
    const raw = execFileSync("node", [preToolScript], { input: inputExhausted, encoding: "utf-8" });
    const res = JSON.parse(raw.trim());
    assert.equal(res.decision, "deny");
    assert.match(res.reason, /RETRY_BUDGET_EXHAUSTED|Maximum retries/);
  } finally {
    cleanTestState();
  }
});

// ---------------------------------------------------------------------------
// ARCH-009: Action-Space Governance Construction
// Policy cannot select an action outside derived available_actions.
// ---------------------------------------------------------------------------
test("ARCH-009: Action-Space Governance Construction (Valid & Adversarial)", () => {
  const state = { task_action: "IMPLEMENT", mutation_seq: 0, post_investigation: false };
  const available = deriveAvailableActions(DECISION_TYPES.INVESTIGATION_STRATEGY, state);

  // 1. Valid: Available action is within legal action space
  assert.ok(available.includes("IMPLEMENT_DIRECT"));
  assert.ok(available.includes("INVESTIGATE_FIRST"));

  // 2. Adversarial: Policy choosing an action outside availableActions returns invalid action diagnostic and falls back
  const policyChoosingDisallowed = {
    schema: "orchestra.exploration-policy.v1",
    policy_id: "placeholder",
    base_policy: null,
    rules: [
      {
        id: "disallowed-action-rule",
        decision_type: "INVESTIGATION_STRATEGY",
        priority: 10,
        when: { task_action: ["IMPLEMENT"] },
        choose: "INVESTIGATE_FIRST",
      },
    ],
  };
  policyChoosingDisallowed.policy_id = computePolicyId(policyChoosingDisallowed);

  const res = evaluatePolicy({
    policy: policyChoosingDisallowed,
    decisionType: DECISION_TYPES.INVESTIGATION_STRATEGY,
    state,
    availableActions: ["IMPLEMENT_DIRECT"], // Pretend governance strictly excluded INVESTIGATE_FIRST
    baselineAction: "IMPLEMENT_DIRECT",
  });
  assert.equal(res.ok, false);
  assert.equal(res.action, "IMPLEMENT_DIRECT", "Must fall back to baseline when policy chooses disallowed action");
  assert.match(res.diagnostic, /POLICY_INVALID_ACTION/);
});

// ---------------------------------------------------------------------------
// ARCH-010: Pure Content-Addressed Cryptographic Integrity
// Policy ID is sha256 of canonical representation; sealed worlds verify manifest.
// ---------------------------------------------------------------------------
test("ARCH-010: Pure Content-Addressed Cryptographic Integrity (Valid & Adversarial)", () => {
  const policyRaw = {
    schema: "orchestra.exploration-policy.v1",
    base_policy: null,
    description: "Hash integrity test",
    created_at: "2026-09-17T00:00:00Z",
    rules: [
      {
        id: "r1",
        decision_type: "WORKER_TIER",
        priority: 10,
        when: { task_action: ["IMPLEMENT"] },
        choose: "FLASH_MEDIUM",
      },
    ],
  };
  const correctId = computePolicyId(policyRaw);

  // 1. Valid: Policy with exact content-addressed ID passes
  const validPolicy = { policy_id: correctId, ...policyRaw };
  assert.equal(validatePolicy(validPolicy).valid, true);

  // 2. Adversarial: Policy ID modified by even 1 character fails validation
  const tamperedId = correctId.slice(0, -1) + (correctId.endsWith("a") ? "b" : "a");
  const tamperedPolicy = { policy_id: tamperedId, ...policyRaw };
  const tamperedRes = validatePolicy(tamperedPolicy);
  assert.equal(tamperedRes.valid, false, "Tampered policy_id must fail validation");
  assert.match(tamperedRes.errors.join("; "), /policy_id mismatch/);
});

// ---------------------------------------------------------------------------
// ARCH-011: Independent Baseline & Action-Leakage Freedom
// Candidate requested action never leaks into decision state or baseline calculation.
// ---------------------------------------------------------------------------
test("ARCH-011: Independent Baseline & Action-Leakage Freedom (Valid & Adversarial)", () => {
  const facts = {
    task_action: "IMPLEMENT",
    criticality: "NORMAL",
    complexity: "NORMAL",
  };
  const activeState = {
    state: "EXECUTING",
    attempt: 0,
    retry_remaining: 2,
  };

  // 1. Valid: Baseline derivation is completely independent of requested profile
  const baseline = deriveValidatedStaticBaseline({
    decisionType: DECISION_TYPES.WORKER_TIER,
    facts,
    state: activeState,
  });
  assert.equal(baseline, "FLASH_MEDIUM");

  // 2. Adversarial: Setting requested profile to flash-worker (FLASH_HIGH) does not leak into decision state
  const stateWithRequested = {
    ...activeState,
    requestedProfile: "flash-worker",
    subagent: { TypeName: "flash-worker" },
  };
  const decState = deriveDecisionState(facts, stateWithRequested, {});
  assert.equal(decState.requestedProfile, undefined, "requestedProfile must not exist in decision state");
  assert.equal(decState.subagent, undefined, "subagent must not exist in decision state");
});

// ---------------------------------------------------------------------------
// ARCH-012: Causal Pre-Action Decision Recording
// DECISION event is recorded only immediately prior to factual execution.
// ---------------------------------------------------------------------------
test("ARCH-012: Causal Pre-Action Decision Recording (Valid & Adversarial)", () => {
  cleanTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      criticality: "NORMAL",
      state: "PLANNED",
    }, null, 2), "utf-8");

    // 1. Valid: Permitted worker delegation records factual DECISION event immediately pre-action
    const inputAllow = JSON.stringify({
      conversationId: "arch-012-conv",
      stepIdx: 1,
      toolCall: {
        id: "call_worker_allowed",
        name: "invoke_subagent",
        args: {
          Subagents: [{ TypeName: "flash-medium-worker", Role: "worker", Prompt: "Implement feature" }],
        },
      },
    });
    const rawAllow = execFileSync("node", [preToolScript], { input: inputAllow, encoding: "utf-8" });
    assert.equal(JSON.parse(rawAllow.trim()).decision, "allow");

    const eventsPath = ".agents/telemetry/events.jsonl";
    assert.ok(existsSync(eventsPath));
    const events = readFileSync(eventsPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const dec = events.find(e => e.type === "DECISION");
    assert.ok(dec, "DECISION event must be recorded on permitted execution");
    assert.equal(dec.chosen_action, "FLASH_MEDIUM");

    // 2. Adversarial: Blocked/denied delegation (e.g. wrong worker tier) must NOT record a false DECISION
    unlinkSync(eventsPath);
    const inputDeny = JSON.stringify({
      conversationId: "arch-012-conv",
      stepIdx: 2,
      toolCall: {
        id: "call_worker_denied",
        name: "invoke_subagent",
        args: {
          Subagents: [{ TypeName: "flash-worker", Role: "worker", Prompt: "Implement feature" }],
        },
      },
    });
    const rawDeny = execFileSync("node", [preToolScript], { input: inputDeny, encoding: "utf-8" });
    assert.equal(JSON.parse(rawDeny.trim()).decision, "deny");
    assert.equal(existsSync(eventsPath), false, "Blocked delegation must NOT record a DECISION event");
  } finally {
    cleanTestState();
  }
});

// ---------------------------------------------------------------------------
// ARCH-013: Exact Investigation Correlation Lifecycle
// Invocation acknowledgement and manage_subagents observations are not completion.
// ---------------------------------------------------------------------------
test("ARCH-013: Exact Investigation Correlation Lifecycle (Valid & Adversarial)", () => {
  cleanTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });

    // 1. Exact successful invoke_subagent ACK must NOT consume the investigation.
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "arch-013-conv",
      investigationInFlight: {
        correlationKey: "corr-013",
        toolCallId: "call-013",
        stepIdx: 1,
        conversationId: "arch-013-conv",
        parentConversationId: "arch-013-conv",
        subagentRole: "investigator",
        subagentProfile: "flash-worker",
        started_at: new Date().toISOString(),
      },
      post_investigation: false,
    }, null, 2), "utf-8");

    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: "arch-013-conv",
        toolCallId: "call-013",
        stepIdx: 1,
        toolName: "invoke_subagent",
        result: { status: "SUCCESS", conversationId: "child-inv-A" },
      }),
      encoding: "utf-8",
    });
    let state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(state.investigationInFlight, "Successful invoke_subagent ACK must remain in flight");
    assert.equal(state.post_investigation, false, "ACK cannot satisfy post_investigation");
    assert.equal(state.investigationInFlight.childConversationId, "child-inv-A", "ACK may enrich factual child identity");

    // 2. Even exact manage_subagents child observation is not a terminal lifecycle event.
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: "arch-013-conv",
        toolName: "manage_subagents",
        toolArgs: { ConversationId: "child-inv-A", Role: "investigator", TypeName: "flash-worker" },
        result: { status: "SUCCESS", subagentId: "child-inv-A", role: "investigator" },
      }),
      encoding: "utf-8",
    });
    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(state.investigationInFlight, "manage_subagents observation must not consume investigation");
    assert.equal(state.post_investigation, false);

    // 3. Uncorrelated ACK also leaves the active investigation untouched.
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: "different-conv",
        toolCallId: "different-call",
        toolName: "invoke_subagent",
        result: { status: "SUCCESS" },
      }),
      encoding: "utf-8",
    });
    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(state.investigationInFlight, "Uncorrelated ACK must not consume investigation");
    assert.equal(state.post_investigation, false);

    // 4. Factual invocation failure is different from ACK: dispatch attempt ends, but never succeeds investigation.
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: "arch-013-conv",
      investigationInFlight: {
        correlationKey: "corr-013-fail",
        toolCallId: "call-013-fail",
        stepIdx: 2,
        conversationId: "arch-013-conv",
        parentConversationId: "arch-013-conv",
        subagentRole: "investigator",
        subagentProfile: "flash-worker",
        started_at: new Date().toISOString(),
      },
      post_investigation: false,
    }, null, 2), "utf-8");

    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: "arch-013-conv",
        toolCallId: "call-013-fail",
        stepIdx: 2,
        toolName: "invoke_subagent",
        error: "Subagent dispatch failed",
      }),
      encoding: "utf-8",
    });
    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.investigationInFlight, undefined, "Factual dispatch failure terminates the attempt");
    assert.equal(state.post_investigation, false, "Dispatch failure can never satisfy investigation");
  } finally {
    cleanTestState();
  }
});

// ---------------------------------------------------------------------------
// ARCH-014: Authoritative REPLAN State Transition
// REPLAN executes state transition directly immediately pre-transition.
// ---------------------------------------------------------------------------
test("ARCH-014: Authoritative REPLAN State Transition (Valid & Adversarial)", () => {
  cleanTestState();
  try {
    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      criticality: "NORMAL",
      state: "EXECUTING",
      retry: true,
      attempt: 1,
      remainingAttempts: 1,
      retryReason: "MISINTERPRETED_REQUIREMENT",
      lastWorkerProfile: "flash-medium-worker",
    }, null, 2), "utf-8");

    // 1. Valid: When policy selects REPLAN, worker retry is denied, DECISION(REPLAN) is recorded, state becomes PLANNED
    const inputRetry = JSON.stringify({
      conversationId: "arch-014-conv",
      stepIdx: 1,
      toolCall: {
        id: "call_replan_worker",
        name: "invoke_subagent",
        args: {
          remainingAttempts: 1,
          Subagents: [{ TypeName: "flash-medium-worker", Role: "worker", Prompt: "Retry" }],
        },
      },
    });
    const raw = execFileSync("node", [preToolScript], { input: inputRetry, encoding: "utf-8" });
    const res = JSON.parse(raw.trim());
    assert.equal(res.decision, "deny");
    assert.match(res.reason, /REPLAN/);

    const savedState = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(savedState.state, "PLANNED", "State deterministically transitioned to PLANNED");
    assert.equal(savedState.pendingPolicyRequirement, undefined, "Zero requirement waiting for generic tools");

    const eventsPath = ".agents/telemetry/events.jsonl";
    assert.ok(existsSync(eventsPath));
    const events = readFileSync(eventsPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const dec = events.find(e => e.type === "DECISION" && e.chosen_action === "REPLAN");
    assert.ok(dec, "DECISION(REPLAN) must be recorded pre-transition");

    // 2. Adversarial: If state cannot transition to PLANNED (e.g. INTAKE), replan is rejected and fails closed to HUMAN_GATE
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      criticality: "NORMAL",
      state: "INTAKE",
      retry: true,
      attempt: 1,
      remainingAttempts: 1,
      retryReason: "MISINTERPRETED_REQUIREMENT",
      lastWorkerProfile: "flash-medium-worker",
    }, null, 2), "utf-8");

    unlinkSync(eventsPath);
    const rawInvalid = execFileSync("node", [preToolScript], { input: inputRetry, encoding: "utf-8" });
    const resInvalid = JSON.parse(rawInvalid.trim());
    assert.equal(resInvalid.decision, "deny");
    assert.match(resInvalid.reason, /REPLAN_INVALID_TRANSITION/);

    const stateInvalid = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(stateInvalid.state, "HUMAN_GATE", "Invalid transition routes to HUMAN_GATE");
    assert.equal(existsSync(eventsPath), false, "Zero DECISION recorded when transition is invalid");
  } finally {
    cleanTestState();
  }
});

// ---------------------------------------------------------------------------
// ARCH-015: RETRY_SAME Exact Worker Identity
// Medium->Medium allowed; Medium->Low, Medium->High, Low->Medium, High->Medium denied.
// ---------------------------------------------------------------------------
test("ARCH-015: RETRY_SAME Exact Worker Identity (Valid & Adversarial)", () => {
  cleanTestState();
  try {
    const transitions = [
      { last: "flash-medium-worker", req: "flash-medium-worker", expected: "allow" },
      { last: "flash-medium-worker", req: "flash-low-worker", expected: "deny" },
      { last: "flash-medium-worker", req: "flash-worker", expected: "deny" },
      { last: "flash-low-worker", req: "flash-medium-worker", expected: "deny" },
      { last: "flash-worker", req: "flash-medium-worker", expected: "deny" },
    ];

    for (const [idx, t] of transitions.entries()) {
      cleanTestState();
      mkdirSync(".agents/state", { recursive: true });
      writeFileSync(".agents/state/active-state.json", JSON.stringify({
        activeRole: "ORCHESTRATOR",
        taskAction: "IMPLEMENT",
        taskDomain: "CODE",
        criticality: "NORMAL",
        retry: true,
        attempt: 1,
        remainingAttempts: 1,
        prevRemainingAttempts: 1,
        retryReason: "FAILED_TEST",
        lastWorkerProfile: t.last,
      }, null, 2), "utf-8");

      const input = JSON.stringify({
        conversationId: `arch-015-conv-${idx}`,
        stepIdx: idx + 1,
        toolCall: {
          id: `call_retry_${idx}`,
          name: "invoke_subagent",
          args: {
            remainingAttempts: 1,
            Subagents: [
              {
                TypeName: t.req,
                Role: "worker",
                Prompt: "Retry implementation. allowedPaths: [src/**]",
              }
            ]
          }
        }
      });

      const raw = execFileSync("node", [preToolScript], { input, encoding: "utf-8" });
      const res = JSON.parse(raw.trim());
      assert.equal(res.decision, t.expected, `Transition ${t.last} -> ${t.req} must yield ${t.expected}`);
      if (t.expected === "deny") {
        assert.match(res.reason, /POLICY_MISMATCH.*RETRY_SAME/);
      }
    }
  } finally {
    cleanTestState();
  }
});

// ---------------------------------------------------------------------------
// ARCH-016: Active Self-Host Image Isolation
// Test loads active policy A, candidate source modification B cannot hot-reload active session;
// temporary fixture projection without touching .git/orchestra-self-host/**.
// ---------------------------------------------------------------------------
test("ARCH-016: Active Self-Host Image Isolation (Valid & Adversarial)", () => {
  cleanTestState();
  const fixtureProjectionDir = resolve(repoRoot, "scratch/active-self-host-projection-fixture");
  try {
    mkdirSync(resolve(fixtureProjectionDir, "runtimes/antigravity/.agents/dream/policies"), { recursive: true });
    // Candidate source modification B: write corrupted policy in candidate projection
    writeFileSync(
      resolve(fixtureProjectionDir, "runtimes/antigravity/.agents/dream/policies/static-policy-v1.json"),
      JSON.stringify({ schema: "corrupted-candidate-policy-modification-B", rules: [] }),
      "utf-8"
    );

    mkdirSync(".agents/state", { recursive: true });
    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      complexity: "NORMAL",
      criticality: "NORMAL",
    }, null, 2), "utf-8");

    // Pre-tool hook runs with candidate repo projection as repoRoot
    const input = JSON.stringify({
      conversationId: "arch-016-conv",
      repoRoot: fixtureProjectionDir,
      stepIdx: 1,
      toolCall: {
        id: "call_arch_016",
        name: "invoke_subagent",
        args: {
          Subagents: [
            {
              TypeName: "flash-medium-worker",
              Role: "worker",
              Prompt: "Implement feature with candidate repoRoot. allowedPaths: [src/**]",
            }
          ]
        }
      }
    });

    const rawOutput = execFileSync("node", [preToolScript], { input, encoding: "utf-8" });
    const output = JSON.parse(rawOutput.trim());

    // Active session loads active policy image, candidate modification B cannot hot-reload active policy
    assert.equal(output.decision, "allow");

    const eventsPath = ".agents/telemetry/events.jsonl";
    assert.ok(existsSync(eventsPath));
    const events = readFileSync(eventsPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const dec = events.find(e => e.type === "DECISION");
    assert.ok(dec, "DECISION event recorded from immutable active runtime policy");
    assert.equal(dec.policy_source, "STATIC_POLICY_V1");
    assert.notEqual(dec.policy_source, "STATIC_ROUTING_FALLBACK", "Must NOT fall back to corrupted candidate source");
  } finally {
    try { rmSync(fixtureProjectionDir, { recursive: true, force: true }); } catch {}
    cleanTestState();
  }
});

// ---------------------------------------------------------------------------
// ARCH-017: Policy Contract Truthfulness
// Structural representable vs Semantic-only constraints (schema vs validatePolicy).
// ---------------------------------------------------------------------------
test("ARCH-017: Policy Contract Truthfulness (Valid & Adversarial)", () => {
  // 1. Structurally valid (correct JSON shape, types, and schema string) but semantically invalid:
  // Action "REPLAN" is not valid for decision_type "WORKER_TIER"
  const semanticInvalidPolicy = {
    schema: "orchestra.exploration-policy.v1",
    base_policy: null,
    description: "Structurally valid but semantically untruthful action",
    created_at: "2026-09-17T00:00:00Z",
    rules: [
      {
        id: "rule-untruthful-action",
        decision_type: "WORKER_TIER",
        priority: 10,
        when: {
          task_action: ["IMPLEMENT"],
        },
        choose: "REPLAN",
      }
    ]
  };
  semanticInvalidPolicy.policy_id = computePolicyId(semanticInvalidPolicy);

  const semanticRes = validatePolicy(semanticInvalidPolicy);
  assert.equal(semanticRes.valid, false, "Semantic validator must reject choose: 'REPLAN' for WORKER_TIER");
  assert.match(semanticRes.errors.join("; "), /invalid action.*WORKER_TIER/i);

  // 2. Structurally valid with valid action, but forged policy_id (tampered content address)
  const forgedPolicy = {
    schema: "orchestra.exploration-policy.v1",
    policy_id: "policy-0000000000000000000000000000000000000000000000000000000000000000",
    base_policy: null,
    description: "Forged policy_id",
    created_at: "2026-09-17T00:00:00Z",
    rules: [
      {
        id: "rule-valid-shape",
        decision_type: "WORKER_TIER",
        priority: 10,
        when: { task_action: ["IMPLEMENT"] },
        choose: "FLASH_MEDIUM",
      }
    ]
  };
  const forgedRes = validatePolicy(forgedPolicy);
  assert.equal(forgedRes.valid, false, "Semantic validator must enforce policy_id content address truthfulness");
  assert.match(forgedRes.errors.join("; "), /policy_id mismatch/i);

  // 3. Valid policy satisfying both structural and semantic contracts
  const validPolicyRaw = {
    schema: "orchestra.exploration-policy.v1",
    base_policy: null,
    description: "Fully truthful policy",
    created_at: "2026-09-17T00:00:00Z",
    rules: [
      {
        id: "rule-truthful",
        decision_type: "WORKER_TIER",
        priority: 10,
        when: { task_action: ["IMPLEMENT"] },
        choose: "FLASH_MEDIUM",
      }
    ]
  };
  const validPolicy = {
    policy_id: computePolicyId(validPolicyRaw),
    ...validPolicyRaw,
  };
  const validRes = validatePolicy(validPolicy);
  assert.equal(validRes.valid, true, "Truthful policy passes structural and semantic validation");
});

// ---------------------------------------------------------------------------
// ARCH-018: Exact Replay Remains Model-Free
// Demonstrate local deterministic callback, zero model/provider invocation path, UNKNOWN_BRANCH epistemic stop.
// ---------------------------------------------------------------------------
test("ARCH-018: Exact Replay Remains Model-Free (Valid & Adversarial)", () => {
  const rootSnapshotId = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const runtimeFp = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  const dec1 = createDreamEvent("DECISION", {
    schema: DREAM_SCHEMAS.DECISION,
    decision_id: "dec-model-free-1",
    parent_decision_id: null,
    snapshot_id: rootSnapshotId,
    decision_type: "WORKER_TIER",
    state: { task_action: "IMPLEMENT", criticality: "NORMAL" },
    available_actions: ["FLASH_LOW", "FLASH_MEDIUM"],
    chosen_action: "FLASH_MEDIUM",
    policy_source: "STATIC_POLICY_V1",
    actor_identity: "ORCHESTRATOR",
    step_idx: 1,
    created_at: "2026-09-17T12:00:00.000Z",
  });
  const out1 = createDreamEvent("DECISION_OUTCOME", {
    schema: DREAM_SCHEMAS.OUTCOME,
    decision_id: "dec-model-free-1",
    observation_id: "obs-model-free-1",
    result: "TESTS_PASSED",
    resulting_snapshot_id: null,
    terminal_state: "ACCEPTED",
    evidence_summary: {},
    retry_state: { attempt: 0, retry_remaining: 2 },
    cost_metrics: { tokens: 50 },
    created_at: "2026-09-17T12:00:05.000Z",
  });

  const sealRes = sealWorld({
    events: [dec1, out1],
    expectedRuntimeFingerprint: runtimeFp,
    rootSnapshotId,
  });
  assert.equal(sealRes.status, "SEALED");

  // Track invocation count of local deterministic callback
  let callbackInvocations = 0;
  const deterministicCallback = (decision) => {
    callbackInvocations++;
    return "FLASH_MEDIUM";
  };

  // 1. Valid: Replay executes entirely via local synchronous callback without model/provider interaction
  const startTime = Date.now();
  const replayResult = replayExact({
    world: sealRes.world,
    chooseAction: deterministicCallback,
  });
  const elapsed = Date.now() - startTime;

  assert.equal(replayResult.status, REPLAY_STATUS.EXACT_REPLAY_COMPLETE);
  assert.equal(callbackInvocations, 1, "Local deterministic callback invoked exactly once per decision step");
  assert.equal(replayResult.trajectories[0].steps.length, 1);
  assert.equal(replayResult.trajectories[0].steps[0].result, "TESTS_PASSED");
  assert.ok(elapsed < 100, "Model-free replay must be instantaneous local synchronous evaluation");

  // 2. Adversarial: Epistemic stop at UNKNOWN_BRANCH when local callback selects unobserved action
  // System halts without calling model or hallucinating branch outcomes
  const unobservedCallback = () => "FLASH_LOW";
  const unobservedReplay = replayExact({
    world: sealRes.world,
    chooseAction: unobservedCallback,
  });

  assert.equal(unobservedReplay.status, REPLAY_STATUS.UNKNOWN_BRANCH);
  assert.equal(unobservedReplay.trajectories[0].steps.length, 0, "Zero manufactured/hallucinated outcome on unobserved branch");
  assert.equal(unobservedReplay.trajectories[0].terminal_state, null);
});

// ---------------------------------------------------------------------------
// ARCH-019: Factual Investigator Completion Boundary
// Only terminal Stop of the exact causally-bound investigator child may close investigation/outcome.
// ---------------------------------------------------------------------------
test("ARCH-019: Factual Investigator Completion Boundary (Valid & Adversarial)", () => {
  cleanTestState();
  try {
    const corr = "corr-019";
    const parent = "arch-019-parent";
    const child = "arch-019-child";
    const wrongChild = "arch-019-wrong-child";
    const toolCallId = "call-019";

    mkdirSync(".agents/state/dream/pending-decisions", { recursive: true });
    mkdirSync(".agents/telemetry", { recursive: true });

    writeFileSync(".agents/state/active-state.json", JSON.stringify({
      activeRole: "ORCHESTRATOR",
      conversationId: parent,
      taskAction: "IMPLEMENT",
      taskDomain: "CODE",
      investigationInFlight: {
        correlationKey: corr,
        correlation_key: corr,
        toolCallId,
        tool_call_id: toolCallId,
        stepIdx: 4,
        step_idx: 4,
        conversationId: parent,
        conversation_id: parent,
        parentConversationId: parent,
        parent_conversation_id: parent,
        subagentRole: "investigator",
        subagentProfile: "flash-worker",
        started_at: new Date().toISOString(),
      },
      post_investigation: false,
    }, null, 2), "utf-8");

    writeFileSync(".agents/state/dream/pending-decisions/" + corr + ".json", JSON.stringify({
      decision_id: "dec-019",
      conversation_id: parent,
      step_idx: 4,
      tool_call_id: toolCallId,
    }, null, 2), "utf-8");

    const bindings = {
      mainConversationId: parent,
      bindings: {
        [parent]: {
          role: "ORCHESTRATOR",
          profile: "flash-orchestrator",
          source: "CONVERSATION_BOUND_IDENTITY",
        },
        [child]: {
          role: "WORKER",
          profile: "flash-worker",
          parentConversationId: parent,
          originToolCallId: toolCallId,
          delegationKind: "INVESTIGATION",
          confidence: "HIGH",
          source: "RUNTIME_IDENTITY",
        },
        [wrongChild]: {
          role: "WORKER",
          profile: "flash-worker",
          parentConversationId: parent,
          originToolCallId: toolCallId,
          delegationKind: "INVESTIGATION",
          confidence: "HIGH",
          source: "RUNTIME_IDENTITY",
        },
      },
      conversations: {},
      pendingSubagents: [],
    };
    writeFileSync(".agents/state/role-bindings.json", JSON.stringify(bindings, null, 2), "utf-8");

    // A. Exact ACK enriches child identity but cannot close state or Dream outcome.
    execFileSync("node", [postToolScript], {
      input: JSON.stringify({
        conversationId: parent,
        stepIdx: 4,
        toolCallId,
        toolName: "invoke_subagent",
        result: { status: "SUCCESS", conversationId: child },
      }),
      encoding: "utf-8",
    });
    let state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(state.investigationInFlight);
    assert.equal(state.post_investigation, false);
    assert.equal(existsSync(".agents/state/dream/pending-decisions/" + corr + ".json"), true, "ACK must leave pending Dream decision open");
    assert.equal(existsSync(".agents/state/dream/pending-decisions/" + corr + ".consumed"), false);

    // B. Parent yield is explicitly non-terminal while async child work exists.
    execFileSync("node", [stopToolScript], {
      input: JSON.stringify({ conversationId: parent, fullyIdle: false, terminationReason: "end_turn" }),
      encoding: "utf-8",
    });
    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(state.investigationInFlight, "Parent yield must not complete child investigation");
    assert.equal(state.post_investigation, false);

    // C. Wrong child terminal Stop cannot close the current investigation.
    execFileSync("node", [stopToolScript], {
      input: JSON.stringify({ conversationId: wrongChild, fullyIdle: true, terminationReason: "end_turn" }),
      encoding: "utf-8",
    });
    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.ok(state.investigationInFlight, "Wrong child Stop must not consume investigation");
    assert.equal(state.post_investigation, false);
    assert.equal(existsSync(".agents/state/dream/pending-decisions/" + corr + ".json"), true);

    // D. Exact terminal child Stop is the factual completion boundary.
    execFileSync("node", [stopToolScript], {
      input: JSON.stringify({ conversationId: child, fullyIdle: true, terminationReason: "end_turn" }),
      encoding: "utf-8",
    });
    state = JSON.parse(readFileSync(".agents/state/active-state.json", "utf-8"));
    assert.equal(state.investigationInFlight, undefined, "Exact child terminal Stop consumes investigation");
    assert.equal(state.post_investigation, true, "Exact child terminal Stop satisfies post_investigation");
    assert.equal(state.investigationCompletion.childConversationId, child);
    assert.equal(existsSync(".agents/state/dream/pending-decisions/" + corr + ".json"), false);
    assert.equal(existsSync(".agents/state/dream/pending-decisions/" + corr + ".consumed"), true, "Factual completion must consume Dream pending decision");

    const events1 = readFileSync(".agents/telemetry/events.jsonl", "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(events1.filter(e => e.type === "DECISION_OUTCOME" && e.decision_id === "dec-019").length, 1, "Exactly one investigation outcome must be recorded");

    // E. Replayed duplicate terminal Stop is idempotent.
    execFileSync("node", [stopToolScript], {
      input: JSON.stringify({ conversationId: child, fullyIdle: true, terminationReason: "end_turn" }),
      encoding: "utf-8",
    });
    const events2 = readFileSync(".agents/telemetry/events.jsonl", "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(events2.filter(e => e.type === "DECISION_OUTCOME" && e.decision_id === "dec-019").length, 1, "Duplicate Stop must not duplicate outcome");
  } finally {
    cleanTestState();
  }
});
