import test from "node:test";
import assert from "node:assert/strict";

import { buildRsiCohorts } from "../../v2/rsi/cohorts.mjs";
import {
  createLearnedPolicyStore,
  validateLearnedPolicyCandidate,
} from "../../v2/rsi/policy-store.mjs";
import {
  evaluatePolicyCandidate,
  resolveLearnedPolicyHierarchy,
} from "../../v2/rsi/evaluation.mjs";
import { evaluatePromotionCandidate } from "../../v2/rsi/promotion.mjs";

function experience(lineageId, suffix, { domainCohort = "software-engineering", extra = {} } = {}) {
  return {
    schema: "orchestra.experience.v2",
    version: 1,
    experienceId: `exp-${String(suffix).padStart(24, "0")}`,
    category: "EXECUTION",
    source: { lineageId },
    domainCohort,
    facts: { providerFamily: "codex", routeClass: "DIRECT_WORK", retryCount: 0 },
    outcome: { terminalOutcome: "SUCCEEDED", success: true },
    generalization: { scope: "GLOBAL_CANDIDATE", projectLineageCount: 4 },
    privacy: { projectionVersion: "1", containsRawProjectContent: false },
    ...extra,
  };
}

function lineages(cohort) {
  return cohort.lineageIds;
}

test("one lineage with many Experience rows is insufficient for cross-project RSI", () => {
  const rows = Array.from({ length: 100 }, (_, index) => experience("lineage-a", index + 1));
  const result = buildRsiCohorts({ experiences: rows, seed: "seed-a" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "RSI_INSUFFICIENT_LINEAGE_DIVERSITY");
  assert.equal(result.distinctLineageCount, 1);
  assert.equal(result.cohorts, null);
});

test("duplicate clones sharing one lineage count once and four independent lineages satisfy the minimum", () => {
  const rows = [
    experience("lineage-a", 1),
    experience("lineage-a", 2, { extra: { privateProjectPayload: { workspace: "clone-two" } } }),
    experience("lineage-b", 3),
    experience("lineage-c", 4),
    experience("lineage-d", 5),
  ];
  const result = buildRsiCohorts({ experiences: rows, seed: "seed-a" });
  assert.equal(result.ok, true);
  assert.equal(result.distinctLineageCount, 4);
  assert.equal(result.cohorts.train.lineageIds.length, 2);
  assert.equal(result.cohorts.evaluate.lineageIds.length, 1);
  assert.equal(result.cohorts.holdout.lineageIds.length, 1);
});

test("TRAIN, EVALUATE and HOLDOUT are disjoint by lineage ID", () => {
  const rows = ["a", "b", "c", "d", "e", "f"].map((id, index) => experience(`lineage-${id}`, index + 1));
  const { cohorts } = buildRsiCohorts({ experiences: rows, seed: "fixed" });
  const train = new Set(lineages(cohorts.train));
  const evaluate = new Set(lineages(cohorts.evaluate));
  const holdout = new Set(lineages(cohorts.holdout));
  for (const id of evaluate) assert.equal(train.has(id), false);
  for (const id of holdout) {
    assert.equal(train.has(id), false);
    assert.equal(evaluate.has(id), false);
  }
});

test("domain cohort construction uses only the requested compatible sanitized domain cohort", () => {
  const rows = [
    experience("lineage-a", 1), experience("lineage-b", 2),
    experience("lineage-c", 3), experience("lineage-d", 4),
    experience("lineage-ops", 5, { domainCohort: "operations" }),
  ];
  const result = buildRsiCohorts({
    experiences: rows,
    seed: "fixed",
    domainCohort: "software-engineering",
  });
  assert.equal(result.ok, true);
  for (const cohort of Object.values(result.cohorts)) {
    assert.equal(cohort.records.every((record) => record.domainCohort === "software-engineering"), true);
    assert.equal(cohort.lineageIds.includes("lineage-ops"), false);
  }
});

test("global candidate cannot be built below the hard four-lineage minimum", () => {
  const rows = ["a", "b", "c"].map((id, index) => experience(`lineage-${id}`, index + 1));
  const result = buildRsiCohorts({ experiences: rows, seed: "fixed" });
  assert.equal(result.ok, false);
  assert.equal(result.candidateEligible, false);
});

test("cohort assignment is deterministic for reordered inputs under the same seed", () => {
  const rows = ["a", "b", "c", "d", "e"].map((id, index) => experience(`lineage-${id}`, index + 1));
  const forward = buildRsiCohorts({ experiences: rows, seed: "stable-seed" });
  const reversed = buildRsiCohorts({ experiences: [...rows].reverse(), seed: "stable-seed" });
  assert.deepEqual(forward.cohorts, reversed.cohorts);
});

test("cohort objects omit private Project payloads and project identity", () => {
  const rows = ["a", "b", "c", "d"].map((id, index) => experience(`lineage-${id}`, index + 1, {
    extra: {
      privateProjectPayload: { canonicalRoot: `/home/private/project-${id}` },
      source: { lineageId: `lineage-${id}`, projectId: `project-${id}` },
    },
  }));
  const result = buildRsiCohorts({ experiences: rows, seed: "privacy" });
  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result.cohorts);
  assert.equal(serialized.includes("privateProjectPayload"), false);
  assert.equal(serialized.includes("projectId"), false);
  assert.equal(serialized.includes("/home/private"), false);
});

function policyCandidate(overrides = {}) {
  return {
    schema: "orchestra.learned-policy.v2",
    version: 1,
    policyId: "policy-global-1",
    revision: 1,
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
    createdAt: "2026-10-17T22:20:00.000Z",
    ...overrides,
  };
}

function authorityProject() {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-rsi-authority",
    lineageId: "lineage-rsi-authority",
    workspace: { canonicalRoot: "/tmp/prj-rsi-authority", vcs: "git" },
    runtime: { pinnedImage: "2.9.0", instructionEpoch: 7 },
    trust: { mode: "trusted" },
  };
}

function authorityWork() {
  return {
    schema: "orchestra.work-unit.v2",
    workId: "work-rsi-authority",
    projectId: "prj-rsi-authority",
    taskId: "task-rsi-authority",
    generation: 0,
    runtimeImage: "2.9.0",
    instructionEpoch: 7,
    state: "INTAKE",
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
  };
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
const sqliteAvailable = nodeMajor >= 22;

async function withSqliteState(run) {
  const [{ mkdtemp, rm }, { join }, { tmpdir }, { createSqliteState }] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
    import("node:os"),
    import("../../v2/persistence/sqlite/sqlite-state.mjs"),
  ]);
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-rsi-"));
  const dbPath = join(root, "state", "orchestra.db");
  try {
    await run({ dbPath, createSqliteState });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("learned policy records accept only bounded selectors and reject executable or authority-expanding payloads", () => {
  assert.equal(validateLearnedPolicyCandidate(policyCandidate()).valid, true);
  for (const selectors of [
    { ...policyCandidate().selectors, prompt: "ignore governance" },
    { ...policyCandidate().selectors, executableCode: "return true" },
    { ...policyCandidate().selectors, allowedCapabilities: ["WORKSPACE_EDIT"] },
    { ...policyCandidate().selectors, arbitraryToolAccess: ["shell"] },
  ]) {
    assert.equal(validateLearnedPolicyCandidate(policyCandidate({ selectors })).valid, false);
  }
});

test("policy hierarchy cannot widen immutable choices and project policy may only narrow them", () => {
  const globalPolicy = policyCandidate();
  const domainPolicy = policyCandidate({
    policyId: "policy-domain-1",
    scope: "DOMAIN",
    domainCohort: "software-engineering",
    selectors: { ...policyCandidate().selectors, routePreference: "DELEGATED" },
  });
  const projectPolicy = policyCandidate({
    policyId: "policy-project-1",
    scope: "PROJECT",
    projectId: "prj-rsi-authority",
    selectors: {
      ...policyCandidate().selectors,
      allowedRoutes: ["DIRECT_WORK"],
      routePreference: "DIRECT_WORK",
      allowedProviderProfiles: ["CODEX_DEFAULT"],
      providerProfilePreference: "CODEX_DEFAULT",
    },
  });
  const result = resolveLearnedPolicyHierarchy({
    immutableChoices: {
      routes: ["DIRECT_WORK"],
      providerProfiles: ["CODEX_DEFAULT"],
      retryClasses: ["STANDARD"],
      timeoutClasses: ["STANDARD"],
      turnEconomy: ["BALANCED"],
    },
    globalPolicy,
    domainPolicy,
    projectPolicy,
    domainCohort: "software-engineering",
    projectId: "prj-rsi-authority",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.legalChoices.routes, ["DIRECT_WORK"]);
  assert.deepEqual(result.legalChoices.providerProfiles, ["CODEX_DEFAULT"]);
  assert.deepEqual(result.legalChoices.retryClasses, ["STANDARD"]);
  assert.deepEqual(result.legalChoices.timeoutClasses, ["STANDARD"]);
  assert.deepEqual(result.legalChoices.turnEconomy, ["BALANCED"]);
  assert.equal(result.preferences.route, "DIRECT_WORK");
  assert.equal(result.preferences.providerProfile, "CODEX_DEFAULT");
});

test("candidate and active learned policy remain distinct durable states with audit history", { skip: !sqliteAvailable }, async () => {
  await withSqliteState(async ({ dbPath, createSqliteState }) => {
    const firstState = createSqliteState({ dbPath });
    const store = createLearnedPolicyStore({ persistence: firstState.learnedPolicies });
    const candidate = policyCandidate();
    assert.equal(store.putCandidate(candidate).ok, true);
    assert.deepEqual(store.inspect(candidate.policyId, candidate.revision), candidate);
    assert.equal(store.active({ scope: "GLOBAL" }), null);
    const activated = store.activate({ policyId: candidate.policyId, revision: candidate.revision });
    assert.equal(activated.ok, true);
    assert.equal(activated.active.policy.lifecycle, "CANDIDATE");
    assert.equal(activated.active.activation.lifecycle, "ACTIVE");
    firstState.close();

    const reopened = createSqliteState({ dbPath });
    const reopenedStore = createLearnedPolicyStore({ persistence: reopened.learnedPolicies });
    const active = reopenedStore.active({ scope: "GLOBAL" });
    assert.equal(active.policy.policyId, candidate.policyId);
    assert.equal(active.policy.revision, candidate.revision);
    assert.equal(active.activation.lifecycle, "ACTIVE");
    assert.equal(reopenedStore.history({ scope: "GLOBAL" }).length, 1);
    reopened.close();
  });
});

test("same learned policy candidate replay converges while conflicting identity fails closed", { skip: !sqliteAvailable }, async () => {
  await withSqliteState(async ({ createSqliteState, dbPath }) => {
    const state = createSqliteState({ dbPath });
    const store = createLearnedPolicyStore({ persistence: state.learnedPolicies });
    const candidate = policyCandidate();
    assert.equal(store.putCandidate(candidate).replayed, false);
    assert.equal(store.putCandidate(structuredClone(candidate)).replayed, true);
    const conflict = policyCandidate({ selectors: { ...candidate.selectors, routePreference: "DIRECT_WORK" } });
    const result = store.putCandidate(conflict);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "RSI_POLICY_IDENTITY_CONFLICT");
    state.close();
  });
});

test("learned policy store corruption fails learning closed without blocking Project authority", { skip: !sqliteAvailable }, async () => {
  await withSqliteState(async ({ createSqliteState, dbPath }) => {
    const state = createSqliteState({ dbPath });
    const project = authorityProject();
    assert.equal(state.projects.register(project).ok, true);
    const store = createLearnedPolicyStore({ persistence: state.learnedPolicies });
    const candidate = policyCandidate();
    assert.equal(store.putCandidate(candidate).ok, true);
    state.close();

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE learned_policy_candidates SET record_digest = ? WHERE policy_id = ? AND revision = ?")
      .run("sha256:corrupt", candidate.policyId, candidate.revision);
    db.close();

    const reopened = createSqliteState({ dbPath });
    assert.deepEqual(reopened.projects.inspect(project.projectId), project);
    const reopenedStore = createLearnedPolicyStore({ persistence: reopened.learnedPolicies });
    assert.throws(
      () => reopenedStore.inspect(candidate.policyId, candidate.revision),
      (error) => error?.code === "ORCHESTRA_RSI_POLICY_STORE_INVALID",
    );
    assert.deepEqual(reopened.projects.inspect(project.projectId), project);
    reopened.close();
  });
});

test("learned policy activation never changes Project or Work generation by itself", { skip: !sqliteAvailable }, async () => {
  await withSqliteState(async ({ createSqliteState, dbPath }) => {
    const state = createSqliteState({ dbPath });
    const project = authorityProject();
    const work = authorityWork();
    assert.equal(state.projects.register(project).ok, true);
    assert.equal(state.work.startCurrent(work).ok, true);
    const beforeProject = structuredClone(state.projects.inspect(project.projectId));
    const beforeWork = structuredClone(state.work.read(project.projectId, work.workId));

    const store = createLearnedPolicyStore({ persistence: state.learnedPolicies });
    const candidate = policyCandidate();
    assert.equal(store.putCandidate(candidate).ok, true);
    assert.equal(store.activate({ policyId: candidate.policyId, revision: candidate.revision }).ok, true);

    assert.deepEqual(state.projects.inspect(project.projectId), beforeProject);
    assert.deepEqual(state.work.read(project.projectId, work.workId), beforeWork);
    assert.equal(state.work.read(project.projectId, work.workId).generation, 0);
    state.close();
  });
});

function promotionExperience(lineageId, suffix, {
  category = "EXECUTION",
  success = true,
  retryCount = 0,
  durationMs = 100,
  generalizationScope = "GLOBAL_CANDIDATE",
} = {}) {
  return experience(lineageId, suffix, {
    extra: {
      category,
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
        scope: generalizationScope,
        projectLineageCount: 4,
      },
    },
  });
}

function fixedCohort(records) {
  return {
    lineageIds: [...new Set(records.map((record) => record.source.lineageId))],
    records,
  };
}

function promotionCohorts({ train, evaluate, holdout = [] }) {
  return {
    train: fixedCohort(train),
    evaluate: fixedCohort(evaluate),
    holdout: fixedCohort(holdout),
  };
}

const promotionGate = Object.freeze({
  minTrainLineages: 2,
  requireSuccess: true,
  metrics: Object.freeze({
    retryCount: Object.freeze({ max: 1 }),
    durationMs: Object.freeze({ max: 1_000 }),
  }),
});

test("promotion requires factual TRAIN support from at least two independent lineages", () => {
  const result = evaluatePromotionCandidate({
    candidate: policyCandidate(),
    cohorts: promotionCohorts({
      train: [promotionExperience("lineage-a", 101)],
      evaluate: [promotionExperience("lineage-b", 102)],
    }),
    gate: promotionGate,
  });
  assert.equal(result.promotable, false);
  assert.equal(result.code, "RSI_TRAIN_LINEAGE_SUPPORT_INSUFFICIENT");
});

test("EVALUATE lineage must be unseen in TRAIN and meet configured factual gates", () => {
  const train = [promotionExperience("lineage-a", 111), promotionExperience("lineage-b", 112)];
  const overlapping = evaluatePromotionCandidate({
    candidate: policyCandidate(),
    cohorts: promotionCohorts({ train, evaluate: [promotionExperience("lineage-b", 113)] }),
    gate: promotionGate,
  });
  assert.equal(overlapping.promotable, false);
  assert.equal(overlapping.code, "RSI_EVALUATE_LINEAGE_OVERLAP");

  const independent = evaluatePromotionCandidate({
    candidate: policyCandidate(),
    cohorts: promotionCohorts({ train, evaluate: [promotionExperience("lineage-c", 114)] }),
    gate: promotionGate,
  });
  assert.equal(independent.promotable, true);
  assert.equal(independent.code, "RSI_EVALUATION_PASSED");
});

test("candidate that passes TRAIN but regresses EVALUATE is rejected", () => {
  const result = evaluatePromotionCandidate({
    candidate: policyCandidate(),
    cohorts: promotionCohorts({
      train: [promotionExperience("lineage-a", 121), promotionExperience("lineage-b", 122)],
      evaluate: [promotionExperience("lineage-c", 123, { durationMs: 2_500 })],
    }),
    gate: promotionGate,
  });
  assert.equal(result.promotable, false);
  assert.equal(result.code, "RSI_EVALUATE_GATE_FAILED");
  assert.equal(result.failure?.metric, "durationMs");
});

test("insufficient or corrupt sanitized Experience never yields promotion", () => {
  const corrupt = promotionExperience("lineage-c", 133);
  delete corrupt.privacy;
  const result = evaluatePromotionCandidate({
    candidate: policyCandidate(),
    cohorts: promotionCohorts({
      train: [promotionExperience("lineage-a", 131), promotionExperience("lineage-b", 132)],
      evaluate: [corrupt],
    }),
    gate: promotionGate,
  });
  assert.equal(result.promotable, false);
  assert.equal(result.code, "RSI_EXPERIENCE_INVALID");
});

test("Counterexample within candidate scope blocks promotion", () => {
  const result = evaluatePromotionCandidate({
    candidate: policyCandidate(),
    cohorts: promotionCohorts({
      train: [promotionExperience("lineage-a", 141), promotionExperience("lineage-b", 142)],
      evaluate: [promotionExperience("lineage-c", 143, { category: "COUNTEREXAMPLE" })],
    }),
    gate: promotionGate,
  });
  assert.equal(result.promotable, false);
  assert.equal(result.code, "RSI_COUNTEREXAMPLE_BLOCKS_PROMOTION");
  assert.deepEqual(result.counterexampleExperienceIds, ["exp-000000000000000000000143"]);
});

test("project-specific successes alone cannot promote a GLOBAL learned policy", () => {
  const result = evaluatePromotionCandidate({
    candidate: policyCandidate(),
    cohorts: promotionCohorts({
      train: [
        promotionExperience("lineage-a", 151, { generalizationScope: "PROJECT" }),
        promotionExperience("lineage-b", 152, { generalizationScope: "PROJECT" }),
      ],
      evaluate: [promotionExperience("lineage-c", 153, { generalizationScope: "PROJECT" })],
    }),
    gate: promotionGate,
  });
  assert.equal(result.promotable, false);
  assert.equal(result.code, "RSI_GLOBAL_EVIDENCE_SCOPE_INSUFFICIENT");
});

test("promotion evidence deterministically records exact Experience IDs, lineages, metrics and policy revision", () => {
  const input = {
    candidate: policyCandidate({ revision: 7 }),
    cohorts: promotionCohorts({
      train: [
        promotionExperience("lineage-b", 162, { retryCount: 1, durationMs: 300 }),
        promotionExperience("lineage-a", 161, { retryCount: 0, durationMs: 100 }),
      ],
      evaluate: [promotionExperience("lineage-c", 163, { retryCount: 1, durationMs: 500 })],
    }),
    gate: promotionGate,
  };
  const first = evaluatePolicyCandidate(input);
  const second = evaluatePolicyCandidate(structuredClone(input));
  assert.deepEqual(first, second);
  assert.equal(first.passed, true);
  assert.deepEqual(first.evidence.policy, { policyId: "policy-global-1", revision: 7, scope: "GLOBAL" });
  assert.deepEqual(first.evidence.train.lineageIds, ["lineage-a", "lineage-b"]);
  assert.deepEqual(first.evidence.train.experienceIds, [
    "exp-000000000000000000000161",
    "exp-000000000000000000000162",
  ]);
  assert.deepEqual(first.evidence.train.metrics, {
    recordCount: 2,
    successCount: 2,
    successRate: 1,
    retryCount: { count: 2, total: 1, average: 0.5, max: 1 },
    durationMs: { count: 2, total: 400, average: 200, max: 300 },
  });
  assert.deepEqual(first.evidence.evaluate.lineageIds, ["lineage-c"]);
  assert.deepEqual(first.evidence.evaluate.experienceIds, ["exp-000000000000000000000163"]);
});
