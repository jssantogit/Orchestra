import test from "node:test";
import assert from "node:assert/strict";

import { evaluateHoldoutReplay, evaluateCounterexampleDemotion } from "../../v2/rsi/replay.mjs";
import { activatePromotionCandidate, demotePromotionCandidate } from "../../v2/rsi/promotion.mjs";
import { createLearnedPolicyStore } from "../../v2/rsi/policy-store.mjs";
import { resolveLearnedPolicyHierarchy } from "../../v2/rsi/evaluation.mjs";

function policyCandidate(overrides = {}) {
  return {
    schema: "orchestra.learned-policy.v2",
    version: 1,
    policyId: "policy-global-replay",
    revision: 2,
    scope: "GLOBAL",
    domainCohort: null,
    projectId: null,
    lifecycle: "CANDIDATE",
    selectors: {
      allowedRoutes: ["DIRECT_WORK", "DELEGATED"],
      routePreference: "DELEGATED",
      allowedProviderProfiles: ["CODEX_DEFAULT", "AGY_DEFAULT"],
      providerProfilePreference: "AGY_DEFAULT",
      allowedRetryClasses: ["STANDARD", "RESILIENT"],
      retryClass: "RESILIENT",
      allowedTimeoutClasses: ["STANDARD", "LONG"],
      timeoutClass: "LONG",
      allowedTurnEconomy: ["BALANCED", "AGGRESSIVE"],
      turnEconomy: "AGGRESSIVE",
    },
    createdAt: "2026-10-17T22:35:00.000Z",
    ...overrides,
  };
}

function experience(lineageId, suffix, {
  success = true,
  retryCount = 0,
  durationMs = 100,
  category = "EXECUTION",
  source = undefined,
  extra = {},
} = {}) {
  return {
    schema: "orchestra.experience.v2",
    version: 1,
    experienceId: `exp-${String(suffix).padStart(24, "0")}`,
    category,
    source: source ?? { lineageId },
    domainCohort: "software-engineering",
    facts: {
      providerFamily: "codex",
      routeClass: "DIRECT_WORK",
      retryCount,
      durationMs,
    },
    outcome: {
      terminalOutcome: success ? "SUCCEEDED" : "FAILED",
      success,
    },
    generalization: {
      scope: "GLOBAL_CANDIDATE",
      projectLineageCount: 4,
    },
    privacy: {
      projectionVersion: "1",
      containsRawProjectContent: false,
    },
    ...extra,
  };
}

function cohort(records) {
  return {
    lineageIds: [...new Set(records.map((record) => record.source.lineageId))].sort(),
    records,
  };
}

function cohorts({ holdout = [experience("lineage-d", 204)], evaluate = [experience("lineage-c", 203)] } = {}) {
  return {
    train: cohort([experience("lineage-a", 201), experience("lineage-b", 202)]),
    evaluate: cohort(evaluate),
    holdout: cohort(holdout),
  };
}

const gate = Object.freeze({
  minTrainLineages: 2,
  requireSuccess: true,
  metrics: Object.freeze({
    retryCount: Object.freeze({ max: 1 }),
    durationMs: Object.freeze({ max: 1_000 }),
  }),
});

function passingPromotionEvidence(candidate = policyCandidate()) {
  return {
    schema: "orchestra.rsi-promotion-evidence.v2",
    version: 1,
    policy: { policyId: candidate.policyId, revision: candidate.revision, scope: candidate.scope },
    gate: structuredClone(gate),
    train: {
      lineageIds: ["lineage-a", "lineage-b"],
      experienceIds: ["exp-000000000000000000000201", "exp-000000000000000000000202"],
      metrics: {},
    },
    evaluate: {
      lineageIds: ["lineage-c"],
      experienceIds: ["exp-000000000000000000000203"],
      metrics: {},
    },
  };
}

test("candidate passing TRAIN/EVALUATE but failing HOLDOUT is not replay-approved", () => {
  const candidate = policyCandidate();
  const result = evaluateHoldoutReplay({
    candidate,
    promotionEvidence: passingPromotionEvidence(candidate),
    holdout: cohort([experience("lineage-d", 204, { durationMs: 2_500 })]),
    gate,
  });
  assert.equal(result.ok, false);
  assert.equal(result.passed, false);
  assert.equal(result.code, "RSI_REPLAY_GATE_FAILED");
  assert.equal(result.failure?.metric, "durationMs");
});

test("HOLDOUT lineage must be absent from TRAIN and EVALUATE evidence", () => {
  const candidate = policyCandidate();
  const result = evaluateHoldoutReplay({
    candidate,
    promotionEvidence: passingPromotionEvidence(candidate),
    holdout: cohort([experience("lineage-c", 204)]),
    gate,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "RSI_HOLDOUT_LINEAGE_OVERLAP");
});

test("replay accepts only sanitized cross-project Experience", () => {
  const candidate = policyCandidate();
  for (const bad of [
    experience("lineage-d", 211, { source: { lineageId: "lineage-d", projectId: "private-project" } }),
    experience("lineage-d", 212, { extra: { privateProjectPayload: { path: "/home/private/source.js" } } }),
    experience("lineage-d", 213, { extra: { privacy: { projectionVersion: "1", containsRawProjectContent: true } } }),
  ]) {
    const result = evaluateHoldoutReplay({
      candidate,
      promotionEvidence: passingPromotionEvidence(candidate),
      holdout: cohort([bad]),
      gate,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "RSI_REPLAY_EXPERIENCE_INVALID");
  }
});

test("replay is deterministic for fixed Experience and policy revision", () => {
  const candidate = policyCandidate({ revision: 7 });
  const input = {
    candidate,
    promotionEvidence: passingPromotionEvidence(candidate),
    holdout: cohort([experience("lineage-d", 221, { retryCount: 1, durationMs: 500 })]),
    gate,
  };
  const first = evaluateHoldoutReplay(input);
  const second = evaluateHoldoutReplay(structuredClone(input));
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  assert.equal(first.passed, true);
  assert.equal(first.code, "RSI_REPLAY_PASSED");
  assert.deepEqual(first.evidence.policy, {
    policyId: candidate.policyId,
    revision: 7,
    scope: "GLOBAL",
  });
  assert.deepEqual(first.evidence.holdout.lineageIds, ["lineage-d"]);
  assert.deepEqual(first.evidence.holdout.experienceIds, ["exp-000000000000000000000221"]);
});

test("missing replay facts fail with insufficient evidence rather than success", () => {
  const candidate = policyCandidate();
  const incomplete = experience("lineage-d", 231);
  delete incomplete.facts.durationMs;
  const result = evaluateHoldoutReplay({
    candidate,
    promotionEvidence: passingPromotionEvidence(candidate),
    holdout: cohort([incomplete]),
    gate,
  });
  assert.equal(result.ok, false);
  assert.equal(result.passed, false);
  assert.equal(result.code, "RSI_REPLAY_INSUFFICIENT_EVIDENCE");
});

test("failed HOLDOUT prevents policyStore activation", () => {
  let activationCalls = 0;
  const candidate = policyCandidate();
  const policyStore = {
    activate() {
      activationCalls += 1;
      return { ok: true };
    },
  };
  const result = activatePromotionCandidate({
    candidate,
    cohorts: cohorts({ holdout: [experience("lineage-d", 241, { success: false })] }),
    gate,
    policyStore,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "RSI_REPLAY_GATE_FAILED");
  assert.equal(activationCalls, 0);
});

test("passing replay activates an auditable policy record with predecessor revision", () => {
  const candidate = policyCandidate();
  const calls = [];
  const policyStore = {
    activate(command) {
      calls.push(command);
      return {
        ok: true,
        replayed: false,
        active: {
          policy: candidate,
          activation: {
            lifecycle: "ACTIVE",
            activationId: 9,
            scopeKey: "GLOBAL",
            policyId: candidate.policyId,
            revision: candidate.revision,
            predecessorPolicyId: "policy-global-replay",
            predecessorRevision: 1,
            activatedAt: "2026-10-17T22:36:00.000Z",
          },
        },
      };
    },
  };

  const result = activatePromotionCandidate({ candidate, cohorts: cohorts(), gate, policyStore });
  assert.equal(result.ok, true);
  assert.equal(result.code, "RSI_POLICY_ACTIVATED");
  assert.deepEqual(calls, [{ policyId: candidate.policyId, revision: candidate.revision }]);
  assert.equal(result.activation.predecessorRevision, 1);
  assert.equal(result.replay.code, "RSI_REPLAY_PASSED");
});

test("activated learned policy remains below immutable governance", () => {
  const candidate = policyCandidate();
  const policyStore = {
    activate() {
      return {
        ok: true,
        replayed: false,
        active: {
          policy: candidate,
          activation: {
            lifecycle: "ACTIVE",
            activationId: 10,
            scopeKey: "GLOBAL",
            policyId: candidate.policyId,
            revision: candidate.revision,
            predecessorPolicyId: null,
            predecessorRevision: null,
            activatedAt: "2026-10-17T22:36:00.000Z",
          },
        },
      };
    },
  };
  const activated = activatePromotionCandidate({ candidate, cohorts: cohorts(), gate, policyStore });
  assert.equal(activated.ok, true);
  const resolved = resolveLearnedPolicyHierarchy({
    immutableChoices: {
      routes: ["DIRECT_WORK"],
      providerProfiles: ["CODEX_DEFAULT"],
      retryClasses: ["STANDARD"],
      timeoutClasses: ["STANDARD"],
      turnEconomy: ["BALANCED"],
    },
    globalPolicy: activated.active.policy,
  });
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.legalChoices.routes, ["DIRECT_WORK"]);
  assert.deepEqual(resolved.legalChoices.providerProfiles, ["CODEX_DEFAULT"]);
  assert.deepEqual(resolved.legalChoices.timeoutClasses, ["STANDARD"]);
});

const nodeMajor = Number(process.versions.node.split(".")[0]);
const sqliteAvailable = nodeMajor >= 22;

async function withSqliteState(run) {
  const [{ mkdtemp, rm }, { join }, { tmpdir }, { createSqliteState }] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
    import("node:os"),
    import("../../v2/persistence/sqlite/sqlite-state.mjs"),
  ]);
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-rsi-rollback-"));
  const dbPath = join(root, "state", "orchestra.db");
  try {
    await run({ dbPath, createSqliteState });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("activated policy rolls back to its exact predecessor revision idempotently and preserves audit history", { skip: !sqliteAvailable }, async () => {
  await withSqliteState(async ({ dbPath, createSqliteState }) => {
    const state = createSqliteState({ dbPath });
    const store = createLearnedPolicyStore({ persistence: state.learnedPolicies });
    const revision1 = policyCandidate({ revision: 1, createdAt: "2026-10-17T22:30:00.000Z" });
    const revision2 = policyCandidate({ revision: 2, createdAt: "2026-10-17T22:35:00.000Z" });
    assert.equal(store.putCandidate(revision1).ok, true);
    assert.equal(store.putCandidate(revision2).ok, true);
    assert.equal(store.activate({ policyId: revision1.policyId, revision: 1 }).ok, true);
    assert.equal(store.activate({ policyId: revision2.policyId, revision: 2 }).ok, true);
    assert.equal(store.history({ scope: "GLOBAL" }).length, 2);

    const first = store.rollback({ policyId: revision2.policyId, revision: 2 });
    assert.equal(first.ok, true);
    assert.equal(first.replayed, false);
    assert.equal(first.active.policy.revision, 1);
    assert.equal(first.rolledBack.policyId, revision2.policyId);
    assert.equal(first.rolledBack.revision, 2);
    assert.equal(store.history({ scope: "GLOBAL" }).length, 3);
    assert.deepEqual(store.inspect(revision2.policyId, 2), revision2);

    const second = store.rollback({ policyId: revision2.policyId, revision: 2 });
    assert.equal(second.ok, true);
    assert.equal(second.replayed, true);
    assert.equal(second.active.policy.revision, 1);
    assert.equal(store.history({ scope: "GLOBAL" }).length, 3);
    state.close();
  });
});

test("qualifying Counterexample demotes active policy to pending review without mutating Experience", () => {
  const candidate = policyCandidate();
  const counterexample = experience("lineage-new", 301, { category: "COUNTEREXAMPLE", success: false });
  const before = structuredClone(counterexample);
  const assessment = evaluateCounterexampleDemotion({ candidate, counterexample });
  assert.equal(assessment.ok, true);
  assert.equal(assessment.qualifies, true);

  const calls = [];
  const policyStore = {
    rollback(command) {
      calls.push(command);
      return {
        ok: true,
        replayed: false,
        active: { policy: policyCandidate({ revision: 1 }) },
        rolledBack: { policyId: candidate.policyId, revision: candidate.revision },
      };
    },
  };
  const result = demotePromotionCandidate({ candidate, counterexample, policyStore });
  assert.equal(result.ok, true);
  assert.equal(result.code, "RSI_POLICY_DEMOTED");
  assert.equal(result.demotion.lifecycle, "PENDING_REVIEW");
  assert.deepEqual(result.demotion.policy, { policyId: candidate.policyId, revision: candidate.revision });
  assert.deepEqual(calls, [{ policyId: candidate.policyId, revision: candidate.revision }]);
  assert.deepEqual(counterexample, before);
});

test("Counterexample outside a DOMAIN policy scope does not demote it", () => {
  const candidate = policyCandidate({
    scope: "DOMAIN",
    domainCohort: "operations",
    projectId: null,
  });
  const counterexample = experience("lineage-new", 302, { category: "COUNTEREXAMPLE", success: false });
  const assessment = evaluateCounterexampleDemotion({ candidate, counterexample });
  assert.equal(assessment.ok, true);
  assert.equal(assessment.qualifies, false);
  assert.equal(assessment.code, "RSI_COUNTEREXAMPLE_OUT_OF_SCOPE");
});

test("corrupt learned policy never makes immutable governance permissive", () => {
  const corrupt = policyCandidate({ selectors: { allowedRoutes: ["FORBIDDEN_ROUTE"], executableCode: "return true" } });
  const result = resolveLearnedPolicyHierarchy({
    immutableChoices: {
      routes: ["DIRECT_WORK"],
      providerProfiles: ["CODEX_DEFAULT"],
      retryClasses: ["STANDARD"],
      timeoutClasses: ["STANDARD"],
      turnEconomy: ["BALANCED"],
    },
    globalPolicy: corrupt,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "RSI_POLICY_INVALID");
});

test("execution without learned policy remains valid on deterministic static baseline", () => {
  const result = resolveLearnedPolicyHierarchy({
    immutableChoices: {
      routes: ["DIRECT_WORK", "DELEGATED"],
      providerProfiles: ["CODEX_DEFAULT", "AGY_DEFAULT"],
      retryClasses: ["STANDARD", "RESILIENT"],
      timeoutClasses: ["STANDARD", "LONG"],
      turnEconomy: ["BALANCED", "AGGRESSIVE"],
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.appliedPolicies, []);
  assert.deepEqual(result.preferences, {
    route: "DIRECT_WORK",
    providerProfile: "CODEX_DEFAULT",
    retryClass: "STANDARD",
    timeoutClass: "STANDARD",
    turnEconomy: "BALANCED",
  });
});
