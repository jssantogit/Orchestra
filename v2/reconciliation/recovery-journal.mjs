import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { validateOperationRecoveryV2 } from "./contracts.mjs";

const RECOVERY_SCHEMA_VERSION = 1;

function success(payload = {}) {
  return { ok: true, ...payload };
}

function failure(reason, payload = {}) {
  return { ok: false, reason, ...payload };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
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

function digest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function commandKey(projectId, commandId) {
  return `${projectId}\u0000${commandId}`;
}

function operationKey(projectId, operationId) {
  return `${projectId}\u0000${operationId}`;
}

function requireState(state) {
  if (!state?.projects?.inspect || !state?.operations?.inspect) {
    throw new TypeError("state with projects.inspect and operations.inspect is required");
  }
  return state;
}

function validateIdentity(state, recovery) {
  if (!validateOperationRecoveryV2(recovery).valid) return failure("RECOVERY_INVALID");
  const project = state.projects.inspect(recovery.projectId);
  if (!project) return failure("PROJECT_NOT_FOUND");
  const operation = state.operations.inspect(recovery.operationId);
  if (!operation) return failure("OPERATION_NOT_FOUND");
  if (operation.projectId !== recovery.projectId) return failure("OPERATION_PROJECT_MISMATCH");
  if (operation.workId !== recovery.workId || operation.generation !== recovery.generation) {
    return failure("RECOVERY_OPERATION_MISMATCH");
  }
  return null;
}

export function createInMemoryRecoveryJournal({ state } = {}) {
  const store = requireState(state);
  const byCommand = new Map();
  const byOperation = new Map();

  return Object.freeze({
    record(recovery) {
      const invalid = validateIdentity(store, recovery);
      if (invalid) return invalid;

      const key = commandKey(recovery.projectId, recovery.commandId);
      const encoded = canonicalJson(recovery);
      const fingerprint = digest(recovery);
      const prior = byCommand.get(key);
      if (prior) {
        if (prior.digest !== fingerprint || prior.encoded !== encoded) {
          return failure("IDEMPOTENCY_CONFLICT");
        }
        return success({ recovery: clone(prior.recovery), replayed: true });
      }

      const stored = clone(recovery);
      byCommand.set(key, { recovery: stored, encoded, digest: fingerprint });
      const opKey = operationKey(recovery.projectId, recovery.operationId);
      const records = byOperation.get(opKey) ?? [];
      records.push(stored);
      byOperation.set(opKey, records);
      return success({ recovery: clone(stored), replayed: false });
    },

    latest({ projectId, operationId } = {}) {
      const records = byOperation.get(operationKey(projectId, operationId));
      return records?.length ? clone(records[records.length - 1]) : null;
    },
  });
}

function recoverySchemaTooNew(version) {
  const error = new Error(`ORCHESTRA_V2_RECOVERY_SCHEMA_TOO_NEW:${version}`);
  error.code = "ORCHESTRA_V2_RECOVERY_SCHEMA_TOO_NEW";
  error.schemaVersion = version;
  error.supportedSchemaVersion = RECOVERY_SCHEMA_VERSION;
  return error;
}

function initializeRecoverySchema(db) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS orchestra_recovery_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const maxRow = db.prepare("SELECT MAX(version) AS version FROM orchestra_recovery_migrations").get();
  const current = Number(maxRow?.version ?? 0);
  if (current > RECOVERY_SCHEMA_VERSION) throw recoverySchemaTooNew(current);
  if (current >= 1) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE operation_recovery_records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        record_digest TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE (project_id, command_id),
        FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT,
        FOREIGN KEY (operation_id) REFERENCES operations(operation_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX operation_recovery_latest_idx
        ON operation_recovery_records(project_id, operation_id, sequence DESC);
    `);
    db.prepare("INSERT INTO orchestra_recovery_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(1, "v2_operation_recovery_journal", new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  }
}

export function createSqliteRecoveryJournal({ dbPath, state, timeoutMs = 5_000 } = {}) {
  if (typeof dbPath !== "string" || dbPath.length === 0 || dbPath === ":memory:") {
    throw new TypeError("file-backed dbPath is required");
  }
  const store = requireState(state);
  const db = new DatabaseSync(dbPath, { timeout: timeoutMs });
  try {
    initializeRecoverySchema(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const getByCommand = db.prepare(`
    SELECT record_json, record_digest
    FROM operation_recovery_records
    WHERE project_id = ? AND command_id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO operation_recovery_records(
      project_id, operation_id, command_id, record_json, record_digest, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const getLatest = db.prepare(`
    SELECT record_json
    FROM operation_recovery_records
    WHERE project_id = ? AND operation_id = ?
    ORDER BY sequence DESC
    LIMIT 1
  `);
  let closed = false;

  return Object.freeze({
    record(recovery) {
      const invalid = validateIdentity(store, recovery);
      if (invalid) return invalid;

      const encoded = canonicalJson(recovery);
      const fingerprint = digest(recovery);
      db.exec("BEGIN IMMEDIATE");
      try {
        const prior = getByCommand.get(recovery.projectId, recovery.commandId);
        if (prior) {
          db.exec("COMMIT");
          if (prior.record_digest !== fingerprint || prior.record_json !== encoded) {
            return failure("IDEMPOTENCY_CONFLICT");
          }
          return success({ recovery: JSON.parse(prior.record_json), replayed: true });
        }

        insert.run(
          recovery.projectId,
          recovery.operationId,
          recovery.commandId,
          encoded,
          fingerprint,
          recovery.recordedAt,
        );
        db.exec("COMMIT");
        return success({ recovery: JSON.parse(encoded), replayed: false });
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the original write failure.
        }
        throw error;
      }
    },

    latest({ projectId, operationId } = {}) {
      const row = getLatest.get(projectId, operationId);
      return row ? JSON.parse(row.record_json) : null;
    },

    close() {
      if (closed) return;
      db.close();
      closed = true;
    },
  });
}
