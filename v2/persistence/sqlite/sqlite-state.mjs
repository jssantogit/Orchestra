import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { validateProjectV2 } from "../../domain/contracts.mjs";

const CURRENT_SCHEMA_VERSION = 1;
const INITIAL_MIGRATION_NAME = "v2_initial_registry";

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function fail(reason, payload = {}) {
  return { ok: false, reason, ...payload };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalValue(value[key]);
  return output;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function requestDigest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function parseRecord(row) {
  return row ? JSON.parse(row.record_json) : null;
}

function schemaTooNewError(version) {
  const error = new Error(`ORCHESTRA_V2_SCHEMA_TOO_NEW:${version}`);
  error.code = "ORCHESTRA_V2_SCHEMA_TOO_NEW";
  error.schemaVersion = version;
  error.supportedSchemaVersion = CURRENT_SCHEMA_VERSION;
  return error;
}

function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction failure.
    }
    throw error;
  }
}

function applyInitialMigration(db) {
  transaction(db, () => {
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
    `);

    const now = new Date().toISOString();
    db.prepare("INSERT INTO orchestra_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(CURRENT_SCHEMA_VERSION, INITIAL_MIGRATION_NAME, now);
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  });
}

function initializeDatabase(db) {
  const row = db.prepare("PRAGMA user_version").get();
  const version = Number(row?.user_version ?? 0);
  if (version > CURRENT_SCHEMA_VERSION) throw schemaTooNewError(version);
  if (version === 0) applyInitialMigration(db);
  if (version !== 0 && version < CURRENT_SCHEMA_VERSION) {
    const error = new Error(`ORCHESTRA_V2_SCHEMA_MIGRATION_MISSING:${version}`);
    error.code = "ORCHESTRA_V2_SCHEMA_MIGRATION_MISSING";
    error.schemaVersion = version;
    error.supportedSchemaVersion = CURRENT_SCHEMA_VERSION;
    throw error;
  }
}

function createProjectRegistry(db) {
  const getById = db.prepare("SELECT * FROM projects WHERE project_id = ?");
  const getByRoot = db.prepare("SELECT * FROM projects WHERE canonical_root = ?");
  const insertProject = db.prepare(`
    INSERT INTO projects(
      project_id, lineage_id, canonical_root, vcs, runtime_image, instruction_epoch,
      trust_mode, record_json, original_request_json, original_request_digest,
      revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);
  const updateRoot = db.prepare(`
    UPDATE projects
    SET canonical_root = ?, record_json = ?, revision = revision + 1, updated_at = ?
    WHERE project_id = ? AND canonical_root = ?
  `);
  const getRebind = db.prepare("SELECT * FROM project_rebinds WHERE command_digest = ?");
  const insertRebind = db.prepare(`
    INSERT INTO project_rebinds(command_digest, project_id, expected_root, new_root, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  return Object.freeze({
    register(project) {
      if (!validateProjectV2(project).valid) return fail("PROJECT_INVALID");
      const requestJson = canonicalJson(project);
      const digest = requestDigest(project);

      return transaction(db, () => {
        const existing = getById.get(project.projectId);
        if (existing) {
          if (existing.original_request_digest === digest && existing.original_request_json === requestJson) {
            return ok({ project: parseRecord(existing), replayed: true });
          }
          return fail("PROJECT_ID_CONFLICT");
        }

        const rootOwner = getByRoot.get(project.workspace.canonicalRoot);
        if (rootOwner) {
          return fail("WORKSPACE_ALREADY_REGISTERED", { projectId: rootOwner.project_id });
        }

        const now = new Date().toISOString();
        insertProject.run(
          project.projectId,
          project.lineageId,
          project.workspace.canonicalRoot,
          project.workspace.vcs,
          project.runtime.pinnedImage,
          project.runtime.instructionEpoch,
          project.trust.mode,
          requestJson,
          requestJson,
          digest,
          now,
          now,
        );
        return ok({ project: JSON.parse(requestJson), replayed: false });
      });
    },

    resolve(rootOrId) {
      const byId = getById.get(rootOrId);
      if (byId) return parseRecord(byId);
      return parseRecord(getByRoot.get(rootOrId));
    },

    inspect(projectId) {
      return parseRecord(getById.get(projectId));
    },

    rebind({ projectId, expectedRoot, newRoot } = {}) {
      if (typeof projectId !== "string" || typeof expectedRoot !== "string" || typeof newRoot !== "string") {
        return fail("PROJECT_REBIND_INVALID");
      }
      const command = { projectId, expectedRoot, newRoot };
      const digest = requestDigest(command);

      return transaction(db, () => {
        const current = getById.get(projectId);
        if (!current) return fail("PROJECT_NOT_FOUND");

        const replay = getRebind.get(digest);
        if (replay) return ok({ project: parseRecord(current), replayed: true });

        if (current.canonical_root !== expectedRoot) {
          return fail("STALE_PROJECT_ROOT", { currentRoot: current.canonical_root });
        }

        if (newRoot === expectedRoot) {
          insertRebind.run(digest, projectId, expectedRoot, newRoot, new Date().toISOString());
          return ok({ project: parseRecord(current), replayed: true });
        }

        const target = getByRoot.get(newRoot);
        if (target && target.project_id !== projectId) {
          return fail("WORKSPACE_ALREADY_REGISTERED", { projectId: target.project_id });
        }

        const next = parseRecord(current);
        next.workspace = { ...next.workspace, canonicalRoot: newRoot };
        if (!validateProjectV2(next).valid) return fail("PROJECT_INVALID");

        const now = new Date().toISOString();
        const update = updateRoot.run(newRoot, canonicalJson(next), now, projectId, expectedRoot);
        if (Number(update.changes) !== 1) {
          const latest = getById.get(projectId);
          return fail("STALE_PROJECT_ROOT", { currentRoot: latest?.canonical_root ?? null });
        }
        insertRebind.run(digest, projectId, expectedRoot, newRoot, now);
        return ok({ project: next, replayed: false });
      });
    },
  });
}

export function createSqliteState({ dbPath, timeoutMs = 5_000 } = {}) {
  if (typeof dbPath !== "string" || dbPath.length === 0) throw new TypeError("dbPath is required");
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath, { timeout: timeoutMs });
  try {
    initializeDatabase(db);
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.close();
    throw error;
  }

  const projects = createProjectRegistry(db);
  let closed = false;

  return Object.freeze({
    projects,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    close() {
      if (closed) return;
      db.close();
      closed = true;
    },
  });
}
