import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { validateExperienceRecord } from "../../experience/contracts.mjs";

function storageError(message, experienceId = null) {
  const error = new Error(message);
  error.code = "ORCHESTRA_EXPERIENCE_STORE_INVALID";
  error.experienceId = experienceId;
  return error;
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

function digestRecord(recordJson) {
  return `sha256:${createHash("sha256").update(recordJson, "utf8").digest("hex")}`;
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
      // Preserve the original storage failure.
    }
    throw error;
  }
}

function validateStoredRow(row) {
  if (!row) return null;
  let record;
  try {
    record = JSON.parse(row.record_json);
  } catch {
    throw storageError(`Experience record is not valid JSON: ${row.experience_id}`, row.experience_id);
  }

  const validation = validateExperienceRecord(record);
  const canonical = canonicalJson(record);
  const digest = digestRecord(canonical);
  const providerFamily = record.facts.providerFamily ?? null;
  const failureClass = record.facts.failureClass ?? record.outcome.failureClass ?? null;
  const recoveryClass = record.facts.recoveryClass ?? record.outcome.recoveryClass ?? null;
  const terminalOutcome = record.outcome.terminalOutcome ?? null;
  const matches = validation.valid
    && record.experienceId === row.experience_id
    && record.category === row.category
    && record.source.projectId === row.source_project_id
    && record.source.lineageId === row.source_lineage_id
    && record.source.workId === row.work_id
    && record.source.operationId === row.operation_id
    && record.domainCohort === row.domain_cohort
    && providerFamily === row.provider_family
    && failureClass === row.failure_class
    && recoveryClass === row.recovery_class
    && terminalOutcome === row.terminal_outcome
    && record.generalization.scope === row.eligibility_scope
    && record.generalization.projectLineageCount === Number(row.lineage_count)
    && canonical === row.record_json
    && digest === row.record_digest;

  if (!matches) {
    throw storageError(`Experience storage columns disagree with record: ${row.experience_id}`, row.experience_id);
  }
  return record;
}

function validateForWrite(record) {
  const validation = validateExperienceRecord(record);
  if (!validation.valid) {
    throw storageError(`Experience record is invalid: ${validation.errors[0]?.message ?? "unknown error"}`, record?.experienceId ?? null);
  }
}

function createMemoryPersistence() {
  const records = new Map();
  return Object.freeze({
    put(record) {
      validateForWrite(record);
      const json = canonicalJson(record);
      const digest = digestRecord(json);
      const existing = records.get(record.experienceId);
      if (existing) {
        if (existing.json === json && existing.digest === digest) {
          return { ok: true, experience: JSON.parse(existing.json), replayed: true, digest };
        }
        return { ok: false, reason: "EXPERIENCE_ID_CONFLICT", experience: JSON.parse(existing.json), digest: existing.digest };
      }
      records.set(record.experienceId, { json, digest });
      return { ok: true, experience: JSON.parse(json), replayed: false, digest };
    },
    inspect(experienceId) {
      const existing = records.get(experienceId);
      return existing ? JSON.parse(existing.json) : null;
    },
    list() {
      return [...records.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, entry]) => JSON.parse(entry.json));
    },
    close() {},
  });
}

export function createSqliteExperiencePersistence({ dbPath, timeoutMs = 5_000 } = {}) {
  if (typeof dbPath !== "string" || dbPath.trim().length === 0) throw new TypeError("dbPath is required");
  if (dbPath === ":memory:") return createMemoryPersistence();

  const db = new DatabaseSync(dbPath, { timeout: timeoutMs });
  const getById = db.prepare("SELECT * FROM experience_records WHERE experience_id = ?");
  const listAll = db.prepare("SELECT * FROM experience_records ORDER BY experience_id ASC");
  const insert = db.prepare(`
    INSERT INTO experience_records(
      experience_id, category, source_project_id, source_lineage_id, work_id, operation_id,
      domain_cohort, provider_family, failure_class, recovery_class, terminal_outcome,
      eligibility_scope, lineage_count, record_json, record_digest, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let closed = false;

  function assertOpen() {
    if (closed) throw storageError("Experience persistence is closed");
  }

  return Object.freeze({
    put(record) {
      assertOpen();
      validateForWrite(record);
      const recordJson = canonicalJson(record);
      const digest = digestRecord(recordJson);
      return transaction(db, () => {
        const existingRow = getById.get(record.experienceId);
        if (existingRow) {
          const existing = validateStoredRow(existingRow);
          if (existingRow.record_json === recordJson && existingRow.record_digest === digest) {
            return { ok: true, experience: existing, replayed: true, digest };
          }
          return {
            ok: false,
            reason: "EXPERIENCE_ID_CONFLICT",
            experience: existing,
            digest: existingRow.record_digest,
          };
        }

        insert.run(
          record.experienceId,
          record.category,
          record.source.projectId,
          record.source.lineageId,
          record.source.workId,
          record.source.operationId,
          record.domainCohort,
          record.facts.providerFamily ?? null,
          record.facts.failureClass ?? record.outcome.failureClass ?? null,
          record.facts.recoveryClass ?? record.outcome.recoveryClass ?? null,
          record.outcome.terminalOutcome ?? null,
          record.generalization.scope,
          record.generalization.projectLineageCount,
          recordJson,
          digest,
          new Date().toISOString(),
        );
        return { ok: true, experience: JSON.parse(recordJson), replayed: false, digest };
      });
    },

    inspect(experienceId) {
      assertOpen();
      return validateStoredRow(getById.get(experienceId));
    },

    list() {
      assertOpen();
      return listAll.all().map(validateStoredRow);
    },

    close() {
      if (closed) return;
      db.close();
      closed = true;
    },
  });
}
