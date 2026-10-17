import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";

function project(overrides = {}) {
  return {
    schema: "orchestra.project.v2",
    projectId: "prj-persist",
    lineageId: "lineage-persist",
    workspace: { canonicalRoot: "C:/Projects/Persist", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
    ...overrides,
  };
}

async function withDb(fn) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-sqlite-"));
  const dbPath = join(root, "orchestra.db");
  try {
    await fn({ root, dbPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("SQLite Project Registry survives process-style close and reopen", async () => {
  await withDb(async ({ dbPath }) => {
    const first = createSqliteState({ dbPath });
    assert.equal(first.projects.register(project()).ok, true);
    first.close();

    const reopened = createSqliteState({ dbPath });
    assert.equal(reopened.projects.inspect("prj-persist").lineageId, "lineage-persist");
    assert.equal(reopened.projects.resolve("C:/Projects/Persist").projectId, "prj-persist");
    reopened.close();
  });
});

test("SQLite Project Registry enforces canonical workspace uniqueness durably", async () => {
  await withDb(async ({ dbPath }) => {
    const state = createSqliteState({ dbPath });
    assert.equal(state.projects.register(project()).ok, true);

    const duplicate = state.projects.register(project({
      projectId: "prj-other",
      lineageId: "lineage-other",
    }));

    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.reason, "WORKSPACE_ALREADY_REGISTERED");
    state.close();
  });
});

test("registration replay after rebind returns current project and survives restart", async () => {
  await withDb(async ({ dbPath }) => {
    const original = project();
    const state = createSqliteState({ dbPath });
    assert.equal(state.projects.register(original).ok, true);
    assert.equal(state.projects.rebind({
      projectId: original.projectId,
      expectedRoot: "C:/Projects/Persist",
      newRoot: "C:/Projects/Persist-Moved",
    }).ok, true);
    state.close();

    const reopened = createSqliteState({ dbPath });
    const registerReplay = reopened.projects.register(original);
    const rebindReplay = reopened.projects.rebind({
      projectId: original.projectId,
      expectedRoot: "C:/Projects/Persist",
      newRoot: "C:/Projects/Persist-Moved",
    });

    assert.equal(registerReplay.ok, true);
    assert.equal(registerReplay.replayed, true);
    assert.equal(registerReplay.project.workspace.canonicalRoot, "C:/Projects/Persist-Moved");
    assert.equal(rebindReplay.ok, true);
    assert.equal(rebindReplay.replayed, true);
    assert.equal(rebindReplay.project.workspace.canonicalRoot, "C:/Projects/Persist-Moved");
    reopened.close();
  });
});

test("failed rebind collision leaves durable registry unchanged", async () => {
  await withDb(async ({ dbPath }) => {
    const state = createSqliteState({ dbPath });
    state.projects.register(project());
    state.projects.register(project({
      projectId: "prj-b",
      lineageId: "lineage-b",
      workspace: { canonicalRoot: "C:/Projects/B", vcs: "git" },
    }));

    const collision = state.projects.rebind({
      projectId: "prj-persist",
      expectedRoot: "C:/Projects/Persist",
      newRoot: "C:/Projects/B",
    });

    assert.equal(collision.ok, false);
    assert.equal(collision.reason, "WORKSPACE_ALREADY_REGISTERED");
    assert.equal(state.projects.resolve("C:/Projects/Persist").projectId, "prj-persist");
    assert.equal(state.projects.resolve("C:/Projects/B").projectId, "prj-b");
    state.close();
  });
});

test("SQLite schema migration ledger initializes through version 5", async () => {
  await withDb(async ({ dbPath }) => {
    const state = createSqliteState({ dbPath });
    state.close();

    const db = new DatabaseSync(dbPath);
    const version = db.prepare("PRAGMA user_version").get().user_version;
    const migration = db.prepare("SELECT version, name FROM orchestra_migrations ORDER BY version").all()
      .map((row) => ({ version: row.version, name: row.name }));
    db.close();

    assert.equal(version, 5);
    assert.deepEqual(migration, [
      { version: 1, name: "v2_initial_registry" },
      { version: 2, name: "v2_work_operations" },
      { version: 3, name: "v2_active_work_head" },
      { version: 4, name: "v2_provider_observations_and_correlations" },
      { version: 5, name: "v2_global_experience" },
    ]);
  });
});

test("newer unsupported schema fails closed before mutation", async () => {
  await withDb(async ({ dbPath }) => {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 999");
    db.close();

    assert.throws(
      () => createSqliteState({ dbPath }),
      (error) => error?.code === "ORCHESTRA_V2_SCHEMA_TOO_NEW" && error?.schemaVersion === 999,
    );

    const check = new DatabaseSync(dbPath);
    assert.equal(check.prepare("PRAGMA user_version").get().user_version, 999);
    const hasProjects = check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get();
    check.close();
    assert.equal(hasProjects, undefined);
  });
});
