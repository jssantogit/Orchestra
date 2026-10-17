import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

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
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function invalid(message, details = {}) {
  const error = new Error(`ORCHESTRA_RSI_POLICY_STORE_INVALID:${message}`);
  error.code = "ORCHESTRA_RSI_POLICY_STORE_INVALID";
  Object.assign(error, details);
  return error;
}

function scopeKey(candidate) {
  if (candidate.scope === "GLOBAL") return "GLOBAL";
  if (candidate.scope === "DOMAIN") return `DOMAIN:${candidate.domainCohort}`;
  if (candidate.scope === "PROJECT") return `PROJECT:${candidate.projectId}`;
  throw invalid("invalid persisted scope", { policyId: candidate.policyId });
}

function parseCandidate(row) {
  if (!row) return null;
  let policy;
  try {
    policy = JSON.parse(row.record_json);
  } catch {
    throw invalid("candidate JSON malformed", { policyId: row.policy_id, revision: Number(row.revision) });
  }
  const expected = digest(policy);
  if (expected !== row.record_digest
    || policy.policyId !== row.policy_id
    || policy.revision !== Number(row.revision)
    || scopeKey(policy) !== row.scope_key) {
    throw invalid("candidate integrity mismatch", { policyId: row.policy_id, revision: Number(row.revision) });
  }
  return policy;
}

function activationEnvelope(candidateRow, activationRow) {
  if (!candidateRow || !activationRow) return null;
  const policy = parseCandidate(candidateRow);
  if (activationRow.policy_id !== policy.policyId
    || Number(activationRow.policy_revision) !== policy.revision
    || activationRow.scope_key !== scopeKey(policy)) {
    throw invalid("activation integrity mismatch", { policyId: policy.policyId, revision: policy.revision });
  }
  return Object.freeze({
    policy,
    activation: Object.freeze({
      lifecycle: "ACTIVE",
      activationId: Number(activationRow.activation_id),
      scopeKey: activationRow.scope_key,
      policyId: activationRow.policy_id,
      revision: Number(activationRow.policy_revision),
      predecessorPolicyId: activationRow.predecessor_policy_id ?? null,
      predecessorRevision: activationRow.predecessor_revision === null
        ? null
        : Number(activationRow.predecessor_revision),
      activatedAt: activationRow.activated_at,
    }),
  });
}

export function createSqliteLearnedPolicyPersistence({ dbPath, timeoutMs = 5_000 } = {}) {
  if (typeof dbPath !== "string" || dbPath.length === 0) throw new TypeError("dbPath is required");
  const db = new DatabaseSync(dbPath, { timeout: timeoutMs });
  db.exec("PRAGMA foreign_keys = ON");

  const getCandidate = db.prepare(`
    SELECT * FROM learned_policy_candidates WHERE policy_id = ? AND revision = ?
  `);
  const insertCandidate = db.prepare(`
    INSERT INTO learned_policy_candidates(
      policy_id, revision, scope_key, scope, domain_cohort, project_id,
      record_json, record_digest, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getActive = db.prepare(`
    SELECT a.*
    FROM learned_policy_active p
    JOIN learned_policy_activations a ON a.activation_id = p.activation_id
    WHERE p.scope_key = ?
  `);
  const getActivation = db.prepare(`
    SELECT * FROM learned_policy_activations WHERE activation_id = ?
  `);
  const insertActivation = db.prepare(`
    INSERT INTO learned_policy_activations(
      scope_key, policy_id, policy_revision, predecessor_policy_id,
      predecessor_revision, activated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const upsertActive = db.prepare(`
    INSERT INTO learned_policy_active(scope_key, policy_id, policy_revision, activation_id, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(scope_key) DO UPDATE SET
      policy_id = excluded.policy_id,
      policy_revision = excluded.policy_revision,
      activation_id = excluded.activation_id,
      updated_at = excluded.updated_at
  `);
  const getHistory = db.prepare(`
    SELECT a.*
    FROM learned_policy_activations a
    WHERE a.scope_key = ?
    ORDER BY a.activation_id ASC
  `);

  function currentEnvelope(key) {
    const activation = getActive.get(key);
    if (!activation) return null;
    const candidate = getCandidate.get(activation.policy_id, activation.policy_revision);
    return activationEnvelope(candidate, activation);
  }

  let closed = false;
  return Object.freeze({
    putCandidate(candidate) {
      const json = canonicalJson(candidate);
      const recordDigest = digest(candidate);
      const key = scopeKey(candidate);
      return transaction(db, () => {
        const existing = getCandidate.get(candidate.policyId, candidate.revision);
        if (existing) {
          const existingPolicy = parseCandidate(existing);
          if (existing.record_digest === recordDigest && existing.record_json === json) {
            return { ok: true, policy: existingPolicy, digest: recordDigest, replayed: true };
          }
          return { ok: false, reason: "RSI_POLICY_IDENTITY_CONFLICT" };
        }
        insertCandidate.run(
          candidate.policyId,
          candidate.revision,
          key,
          candidate.scope,
          candidate.domainCohort,
          candidate.projectId,
          json,
          recordDigest,
          candidate.createdAt,
        );
        return { ok: true, policy: structuredClone(candidate), digest: recordDigest, replayed: false };
      });
    },

    inspect(policyId, revision) {
      return parseCandidate(getCandidate.get(policyId, revision));
    },

    activate({ policyId, revision } = {}) {
      return transaction(db, () => {
        const row = getCandidate.get(policyId, revision);
        if (!row) return { ok: false, reason: "RSI_POLICY_NOT_FOUND" };
        const candidate = parseCandidate(row);
        const key = scopeKey(candidate);
        const current = currentEnvelope(key);
        if (current?.policy.policyId === policyId && current.policy.revision === revision) {
          return { ok: true, active: current, replayed: true };
        }
        const now = new Date().toISOString();
        const result = insertActivation.run(
          key,
          policyId,
          revision,
          current?.policy.policyId ?? null,
          current?.policy.revision ?? null,
          now,
        );
        const activationId = Number(result.lastInsertRowid);
        upsertActive.run(key, policyId, revision, activationId, now);
        const activation = getActivation.get(activationId);
        return { ok: true, active: activationEnvelope(row, activation), replayed: false };
      });
    },

    active({ scopeKey } = {}) {
      return currentEnvelope(scopeKey);
    },

    history({ scopeKey } = {}) {
      return getHistory.all(scopeKey).map((activation) => {
        const candidate = getCandidate.get(activation.policy_id, activation.policy_revision);
        return activationEnvelope(candidate, activation);
      });
    },

    close() {
      if (closed) return;
      db.close();
      closed = true;
    },
  });
}
