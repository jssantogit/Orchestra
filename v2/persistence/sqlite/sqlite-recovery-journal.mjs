import { DatabaseSync } from "node:sqlite";

import {
  canonicalRecoveryJson,
  recoveryDigest,
  requireRecoveryState,
  validateRecoveryIdentity,
} from "../../reconciliation/recovery-journal.mjs";

const RECOVERY_SCHEMA_VERSION = 1;

function success(payload = {}) {
  return { ok: true, ...payload };
}

function failure(reason, payload = {}) {
  return { ok: false, reason, ...payload };
}

function recoverySchemaTooNew(version) {
  const error = new Error(`ORCHESTRA_V2_RECOVERY_SCHEMA_TOO_NEW:${version}`);
  error.code = "ORCHESTRA_V2_RECOVERY_SCHEMA_TOO_NEW";
  error.schemaVersion = version;
  error.supportedSchemaVersion = RECOVERY_SCHEMA_VERSION;
  return error;
}

function recoveryCorrupt(detail, fields = {}) {
  const error = new Error(`ORCHESTRA_V2_RECOVERY_CORRUPT:${detail}`);
  error.code = "ORCHESTRA_V2_RECOVERY_CORRUPT";
  error.detail = detail;
  Object.assign(error, fields);
  return error;
}

function initializeRecoverySchema(db) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
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

    if (current < 1) {
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
    }

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
  const store = requireRecoveryState(state);
  const db = new DatabaseSync(dbPath, { timeout: timeoutMs });
  try {
    initializeRecoverySchema(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const getByCommand = db.prepare(`
    SELECT project_id, operation_id, command_id, record_json, record_digest, recorded_at
    FROM operation_recovery_records
    WHERE project_id = ? AND command_id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO operation_recovery_records(
      project_id, operation_id, command_id, record_json, record_digest, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const getLatest = db.prepare(`
    SELECT project_id, operation_id, command_id, record_json, record_digest, recorded_at
    FROM operation_recovery_records
    WHERE project_id = ? AND operation_id = ?
    ORDER BY sequence DESC
    LIMIT 1
  `);
  let closed = false;

  function decodeRow(row, expected = {}) {
    if (!row) return null;
    let recovery;
    try {
      recovery = JSON.parse(row.record_json);
    } catch {
      throw recoveryCorrupt("INVALID_JSON");
    }

    const encoded = canonicalRecoveryJson(recovery);
    const digest = recoveryDigest(recovery);
    if (row.record_json !== encoded || row.record_digest !== digest) {
      throw recoveryCorrupt("DIGEST_MISMATCH", {
        projectId: row.project_id,
        operationId: row.operation_id,
        commandId: row.command_id,
      });
    }

    if (row.project_id !== recovery.projectId
      || row.operation_id !== recovery.operationId
      || row.command_id !== recovery.commandId
      || row.recorded_at !== recovery.recordedAt) {
      throw recoveryCorrupt("INDEX_IDENTITY_MISMATCH", {
        projectId: row.project_id,
        operationId: row.operation_id,
        commandId: row.command_id,
      });
    }

    if ((expected.projectId !== undefined && recovery.projectId !== expected.projectId)
      || (expected.operationId !== undefined && recovery.operationId !== expected.operationId)
      || (expected.commandId !== undefined && recovery.commandId !== expected.commandId)) {
      throw recoveryCorrupt("QUERY_IDENTITY_MISMATCH", expected);
    }

    const identityFailure = validateRecoveryIdentity(store, recovery);
    if (identityFailure) {
      throw recoveryCorrupt("INVALID_RECOVERY_FACT", {
        validationReason: identityFailure.reason,
        projectId: recovery.projectId,
        operationId: recovery.operationId,
        commandId: recovery.commandId,
      });
    }
    return recovery;
  }

  return Object.freeze({
    record(recovery) {
      const invalid = validateRecoveryIdentity(store, recovery);
      if (invalid) return invalid;

      const encoded = canonicalRecoveryJson(recovery);
      const fingerprint = recoveryDigest(recovery);
      db.exec("BEGIN IMMEDIATE");
      try {
        const priorRow = getByCommand.get(recovery.projectId, recovery.commandId);
        if (priorRow) {
          const prior = decodeRow(priorRow, {
            projectId: recovery.projectId,
            commandId: recovery.commandId,
          });
          db.exec("COMMIT");
          if (priorRow.record_digest !== fingerprint || priorRow.record_json !== encoded) {
            return failure("IDEMPOTENCY_CONFLICT");
          }
          return success({ recovery: prior, replayed: true });
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

    byCommand({ projectId, commandId } = {}) {
      return decodeRow(getByCommand.get(projectId, commandId), { projectId, commandId });
    },

    latest({ projectId, operationId } = {}) {
      return decodeRow(getLatest.get(projectId, operationId), { projectId, operationId });
    },

    close() {
      if (closed) return;
      db.close();
      closed = true;
    },
  });
}
