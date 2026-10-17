import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

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
    projectLineageIds: ["lineage-a"],
    requestedScope: "PROJECT",
    projectionVersion: "1",
    ...overrides,
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  return result.experience;
}

function project(projectId = "prj-authority") {
  return {
    schema: "orchestra.project.v2",
    projectId,
    lineageId: `lineage-${projectId}`,
    workspace: { canonicalRoot: `/tmp/${projectId}`, vcs: "git" },
    runtime: { pinnedImage: "sha256:image", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  };
}

async function withDb(fn) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-experience-"));
  const dbPath = join(root, "state", "orchestra.db");
  try {
    await fn(dbPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("projected Experience persists globally, replays idempotently, and survives restart", async () => {
  await withDb(async (dbPath) => {
    const record = projected();
    const firstState = createSqliteState({ dbPath });
    const first = createExperienceStore({ persistence: firstState.experience });
    const inserted = first.put(record);
    assert.equal(inserted.ok, true);
    assert.equal(inserted.replayed, false);
    assert.match(inserted.digest, /^sha256:[0-9a-f]{64}$/);
    const replay = first.put(structuredClone(record));
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.digest, inserted.digest);
    firstState.close();

    const reopenedState = createSqliteState({ dbPath });
    const reopened = createExperienceStore({ persistence: reopenedState.experience });
    assert.deepEqual(reopened.inspect(record.experienceId), record);
    assert.deepEqual(reopened.list().map((entry) => entry.experienceId), [record.experienceId]);
    reopenedState.close();
  });
});

test("same Experience identity with conflicting payload fails closed", async () => {
  await withDb(async (dbPath) => {
    const state = createSqliteState({ dbPath });
    const store = createExperienceStore({ persistence: state.experience });
    const record = projected();
    assert.equal(store.put(record).ok, true);

    const conflict = structuredClone(record);
    conflict.outcome = { terminalOutcome: "FAILED", success: false };
    const result = store.put(conflict);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "EXPERIENCE_ID_CONFLICT");
    assert.deepEqual(store.inspect(record.experienceId), record);
    state.close();
  });
});

test("Project A and B Experience share one global store while retaining internal attribution", async () => {
  await withDb(async (dbPath) => {
    const state = createSqliteState({ dbPath });
    const store = createExperienceStore({ persistence: state.experience });
    const a = projected();
    const b = projected({
      sourceProjectId: "prj-b",
      sourceLineageId: "lineage-b",
      workId: "work-b",
      operationId: "op-b",
      projectLineageIds: ["lineage-b"],
    });
    assert.equal(store.put(a).ok, true);
    assert.equal(store.put(b).ok, true);
    const listed = store.list();
    assert.deepEqual(listed.map((entry) => entry.source.projectId).sort(), ["prj-a", "prj-b"]);
    state.close();
  });
});

test("tampered persisted Experience is detected on read", async () => {
  await withDb(async (dbPath) => {
    const state = createSqliteState({ dbPath });
    const store = createExperienceStore({ persistence: state.experience });
    const record = projected();
    assert.equal(store.put(record).ok, true);
    state.close();

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE experience_records SET record_json = ? WHERE experience_id = ?")
      .run(JSON.stringify({ ...record, domainCohort: "tampered" }), record.experienceId);
    db.close();

    const reopenedState = createSqliteState({ dbPath });
    const reopened = createExperienceStore({ persistence: reopenedState.experience });
    assert.throws(
      () => reopened.inspect(record.experienceId),
      (error) => error?.code === "ORCHESTRA_EXPERIENCE_STORE_INVALID" && error?.experienceId === record.experienceId,
    );
    reopenedState.close();
  });
});

test("Experience corruption cannot weaken or block ordinary Project authority reads", async () => {
  await withDb(async (dbPath) => {
    const state = createSqliteState({ dbPath });
    const authorityProject = project();
    assert.equal(state.projects.register(authorityProject).ok, true);
    const store = createExperienceStore({ persistence: state.experience });
    const record = projected();
    assert.equal(store.put(record).ok, true);
    state.close();

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE experience_records SET record_digest = ? WHERE experience_id = ?")
      .run("sha256:corrupt", record.experienceId);
    db.close();

    const reopened = createSqliteState({ dbPath });
    assert.deepEqual(reopened.projects.inspect(authorityProject.projectId), authorityProject);
    assert.throws(
      () => createExperienceStore({ persistence: reopened.experience }).inspect(record.experienceId),
      (error) => error?.code === "ORCHESTRA_EXPERIENCE_STORE_INVALID",
    );
    assert.deepEqual(reopened.projects.inspect(authorityProject.projectId), authorityProject);
    reopened.close();
  });
});

test("deleting Experience rows cannot create authority or mutate registered Projects", async () => {
  await withDb(async (dbPath) => {
    const state = createSqliteState({ dbPath });
    const authorityProject = project("prj-stable");
    assert.equal(state.projects.register(authorityProject).ok, true);
    const store = createExperienceStore({ persistence: state.experience });
    assert.equal(store.put(projected()).ok, true);
    state.close();

    const db = new DatabaseSync(dbPath);
    db.exec("DELETE FROM experience_records");
    db.close();

    const reopened = createSqliteState({ dbPath });
    assert.deepEqual(reopened.projects.inspect(authorityProject.projectId), authorityProject);
    assert.equal(createExperienceStore({ persistence: reopened.experience }).list().length, 0);
    reopened.close();
  });
});
