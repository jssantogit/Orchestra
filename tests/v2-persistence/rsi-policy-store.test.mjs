import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { createLearnedPolicyStore } from "../../v2/rsi/policy-store.mjs";
import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";

function candidate(overrides = {}) {
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
      routePreference: "DIRECT_WORK",
    },
    createdAt: "2026-10-17T22:20:00.000Z",
    ...overrides,
  };
}

function project() {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-rsi-authority",
    lineageId: "lineage-rsi-authority",
    workspace: { canonicalRoot: "/tmp/prj-rsi-authority", vcs: "git" },
    runtime: { pinnedImage: "2.9.0", instructionEpoch: 7 },
    trust: { mode: "trusted" },
  };
}

function work() {
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

async function withDb(run) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-rsi-policy-"));
  const dbPath = join(root, "state", "orchestra.db");
  try {
    await run(dbPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("learned policy candidate and activation persist across restart with audit history", async () => {
  await withDb(async (dbPath) => {
    const firstState = createSqliteState({ dbPath });
    assert.equal(firstState.schemaVersion, 6);
    const firstStore = createLearnedPolicyStore({ persistence: firstState.learnedPolicies });
    const policy = candidate();
    assert.equal(firstStore.putCandidate(policy).ok, true);
    assert.equal(firstStore.active({ scope: "GLOBAL" }), null);
    assert.equal(firstStore.activate({ policyId: policy.policyId, revision: policy.revision }).ok, true);
    firstState.close();

    const reopened = createSqliteState({ dbPath });
    const store = createLearnedPolicyStore({ persistence: reopened.learnedPolicies });
    const active = store.active({ scope: "GLOBAL" });
    assert.equal(active.policy.policyId, policy.policyId);
    assert.equal(active.policy.lifecycle, "CANDIDATE");
    assert.equal(active.activation.lifecycle, "ACTIVE");
    assert.equal(store.history({ scope: "GLOBAL" }).length, 1);
    reopened.close();
  });
});

test("candidate replay converges and same identity with different selectors fails closed", async () => {
  await withDb(async (dbPath) => {
    const state = createSqliteState({ dbPath });
    const store = createLearnedPolicyStore({ persistence: state.learnedPolicies });
    const policy = candidate();
    assert.equal(store.putCandidate(policy).replayed, false);
    assert.equal(store.putCandidate(structuredClone(policy)).replayed, true);
    const conflict = candidate({ selectors: { allowedRoutes: ["DIRECT_WORK"], routePreference: "DIRECT_WORK" } });
    const result = store.putCandidate(conflict);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "RSI_POLICY_IDENTITY_CONFLICT");
    state.close();
  });
});

test("policy corruption fails learning closed without blocking project authority", async () => {
  await withDb(async (dbPath) => {
    const first = createSqliteState({ dbPath });
    const authority = project();
    assert.equal(first.projects.register(authority).ok, true);
    const store = createLearnedPolicyStore({ persistence: first.learnedPolicies });
    const policy = candidate();
    assert.equal(store.putCandidate(policy).ok, true);
    first.close();

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE learned_policy_candidates SET record_digest = ? WHERE policy_id = ? AND revision = ?")
      .run("sha256:corrupt", policy.policyId, policy.revision);
    db.close();

    const reopened = createSqliteState({ dbPath });
    assert.deepEqual(reopened.projects.inspect(authority.projectId), authority);
    const corrupted = createLearnedPolicyStore({ persistence: reopened.learnedPolicies });
    assert.throws(
      () => corrupted.inspect(policy.policyId, policy.revision),
      (error) => error?.code === "ORCHESTRA_RSI_POLICY_STORE_INVALID",
    );
    assert.deepEqual(reopened.projects.inspect(authority.projectId), authority);
    reopened.close();
  });
});

test("policy activation does not mutate Project or active Work generation", async () => {
  await withDb(async (dbPath) => {
    const state = createSqliteState({ dbPath });
    const authority = project();
    const activeWork = work();
    assert.equal(state.projects.register(authority).ok, true);
    assert.equal(state.work.startCurrent(activeWork).ok, true);
    const beforeProject = structuredClone(state.projects.inspect(authority.projectId));
    const beforeWork = structuredClone(state.work.read(authority.projectId, activeWork.workId));

    const store = createLearnedPolicyStore({ persistence: state.learnedPolicies });
    const policy = candidate();
    assert.equal(store.putCandidate(policy).ok, true);
    assert.equal(store.activate({ policyId: policy.policyId, revision: policy.revision }).ok, true);

    assert.deepEqual(state.projects.inspect(authority.projectId), beforeProject);
    assert.deepEqual(state.work.read(authority.projectId, activeWork.workId), beforeWork);
    assert.equal(state.work.read(authority.projectId, activeWork.workId).generation, 0);
    state.close();
  });
});
