import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createExperienceQuery } from "../../v2/experience/query.mjs";
import { projectExperience } from "../../v2/experience/projector.mjs";
import { createExperienceStore } from "../../v2/experience/store.mjs";
import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";

function projected(overrides = {}) {
  const result = projectExperience({
    category: "DIAGNOSTIC",
    sourceProjectId: "prj-a",
    sourceLineageId: "lineage-a",
    workId: "work-a",
    operationId: "op-a",
    domainCohort: "software-engineering",
    facts: {
      failureClass: "OWNER_TERMINATED",
      recoveryClass: "RECONCILED",
      providerFamily: "codex",
      osFamily: "linux",
      runtimeVersion: "2.7.0",
    },
    outcome: { terminalOutcome: "RECOVERED", success: true },
    projectLineageIds: ["lineage-a", "lineage-independent"],
    requestedScope: "GLOBAL_CANDIDATE",
    projectionVersion: "1",
    ...overrides,
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  return result.experience;
}

async function withDb(fn) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-experience-query-"));
  const dbPath = join(root, "state", "orchestra.db");
  try {
    await fn(dbPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("SQLite Experience query applies only fixed sanitized filters and deterministic pagination", async () => {
  await withDb(async (dbPath) => {
    const state = createSqliteState({ dbPath });
    const store = createExperienceStore({ persistence: state.experience });
    const matching = projected();
    const other = projected({
      category: "PERFORMANCE",
      sourceProjectId: "prj-b",
      sourceLineageId: "lineage-b",
      workId: "work-b",
      operationId: "op-b",
      domainCohort: "documentation",
      facts: {
        providerFamily: "antigravity",
        osFamily: "windows",
        runtimeVersion: "2.7.0",
        latencyBucket: "LOW",
      },
      outcome: { terminalOutcome: "SUCCEEDED", success: true },
      projectLineageIds: ["lineage-b", "lineage-independent-b"],
    });
    store.put(other);
    store.put(matching);

    const query = createExperienceQuery({ persistence: state.experience });
    const result = query.crossProject({
      filters: {
        category: "DIAGNOSTIC",
        providerFamily: "codex",
        domainCohort: "software-engineering",
        failureClass: "OWNER_TERMINATED",
        recoveryClass: "RECONCILED",
        terminalOutcome: "RECOVERED",
        eligibilityScope: "GLOBAL_CANDIDATE",
        minProjectLineageCount: 2,
      },
      limit: 1,
    });

    assert.deepEqual(result.items.map((record) => record.experienceId), [matching.experienceId]);
    assert.equal(result.items[0].source.projectId, undefined);
    state.close();
  });
});

test("SQLite project-private Experience query cannot cross source project scope", async () => {
  await withDb(async (dbPath) => {
    const state = createSqliteState({ dbPath });
    const store = createExperienceStore({ persistence: state.experience });
    store.put(projected());
    store.put(projected({
      sourceProjectId: "prj-b",
      sourceLineageId: "lineage-b",
      workId: "work-b",
      operationId: "op-b",
      projectLineageIds: ["lineage-b", "lineage-independent-b"],
    }));

    const query = createExperienceQuery({ persistence: state.experience });
    const a = query.projectPrivate({ projectId: "prj-a" });
    assert.equal(a.items.length, 1);
    assert.equal(a.items[0].source.projectId, "prj-a");
    assert.equal(a.items[0].source.workId, "work-a");
    state.close();
  });
});
