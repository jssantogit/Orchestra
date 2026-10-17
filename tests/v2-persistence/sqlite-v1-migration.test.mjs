import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";

async function withDb(fn) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-migration-"));
  const dbPath = join(root, "orchestra.db");
  try {
    await fn({ dbPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createLegacyV1Database(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE orchestra_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      lineage_id TEXT NOT NULL,
      canonical_root TEXT NOT NULL UNIQUE,
      vcs TEXT NOT NULL,
      runtime_image TEXT NOT NULL,
      instruction_epoch INTEGER NOT NULL CHECK (instruction_epoch >= 0),
      trust_mode TEXT NOT NULL,
      record_json TEXT NOT NULL,
      original_request_json TEXT NOT NULL,
      original_request_digest TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE project_rebinds (
      command_digest TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      expected_root TEXT NOT NULL,
      new_root TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT
    ) STRICT;
    PRAGMA user_version = 1;
  `);
  const project = {
    schema: "orchestra.project.v2",
    projectId: "prj-legacy",
    lineageId: "lineage-legacy",
    workspace: { canonicalRoot: "C:/Projects/Legacy", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  };
  const json = JSON.stringify(project);
  const now = "2026-10-16T22:00:00.000Z";
  db.prepare("INSERT INTO orchestra_migrations(version, name, applied_at) VALUES (1, 'v2_initial_registry', ?)").run(now);
  db.prepare(`
    INSERT INTO projects(
      project_id, lineage_id, canonical_root, vcs, runtime_image, instruction_epoch,
      trust_mode, record_json, original_request_json, original_request_digest,
      revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    project.projectId,
    project.lineageId,
    project.workspace.canonicalRoot,
    project.workspace.vcs,
    project.runtime.pinnedImage,
    project.runtime.instructionEpoch,
    project.trust.mode,
    json,
    json,
    "legacy-digest",
    now,
    now,
  );
  db.close();
}

test("opening a schema v1 registry migrates transactionally to v3 without losing project facts", async () => {
  await withDb(async ({ dbPath }) => {
    createLegacyV1Database(dbPath);

    const state = createSqliteState({ dbPath });
    assert.equal(state.schemaVersion, 3);
    assert.equal(state.projects.inspect("prj-legacy").lineageId, "lineage-legacy");
    assert.equal(state.work.current("prj-legacy"), null);
    state.close();

    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3);
    const migrations = db.prepare("SELECT version, name FROM orchestra_migrations ORDER BY version").all()
      .map((row) => ({ version: row.version, name: row.name }));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('work_units','operations','project_work_heads') ORDER BY name").all()
      .map((row) => row.name);
    db.close();

    assert.deepEqual(migrations, [
      { version: 1, name: "v2_initial_registry" },
      { version: 2, name: "v2_work_operations" },
      { version: 3, name: "v2_active_work_head" },
    ]);
    assert.deepEqual(tables, ["operations", "project_work_heads", "work_units"]);
  });
});
