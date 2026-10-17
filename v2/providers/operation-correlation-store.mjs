const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/i;

function fail(reason, payload = {}) {
  return { ok: false, reason, ...payload };
}

function validKeyPart(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function parseRow(row) {
  if (!row) return null;
  return {
    provider: row.provider,
    projectId: row.project_id,
    correlationHash: row.correlation_hash,
    operationId: row.operation_id,
    workId: row.work_id,
    generation: Number(row.generation),
    actorIdHash: row.actor_id_hash,
  };
}

function sameCorrelation(left, right) {
  return left.provider === right.provider
    && left.projectId === right.projectId
    && left.correlationHash === right.correlationHash
    && left.operationId === right.operationId
    && left.workId === right.workId
    && left.generation === right.generation
    && left.actorIdHash === right.actorIdHash;
}

function writeTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}

export function createOperationCorrelationStore(db) {
  const getRow = db.prepare(`
    SELECT * FROM provider_operation_correlations
    WHERE provider = ? AND project_id = ? AND correlation_hash = ?
  `);
  const getOperation = db.prepare(`
    SELECT project_id, work_id, generation FROM operations WHERE operation_id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO provider_operation_correlations(
      provider, project_id, correlation_hash, operation_id, work_id, generation, actor_id_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  return Object.freeze({
    put(correlation = {}) {
      const { provider, projectId, correlationHash, operationId, workId, generation, actorIdHash } = correlation;
      if (!validKeyPart(provider) || !validKeyPart(projectId) || !HASH_PATTERN.test(correlationHash ?? "")
        || !validKeyPart(operationId) || !validKeyPart(workId)
        || !Number.isSafeInteger(generation) || generation < 0
        || !HASH_PATTERN.test(actorIdHash ?? "")) {
        return fail("OPERATION_CORRELATION_INVALID");
      }

      return writeTransaction(db, () => {
        const operation = getOperation.get(operationId);
        if (!operation) return fail("OPERATION_CORRELATION_OPERATION_NOT_FOUND");
        if (operation.project_id !== projectId || operation.work_id !== workId || Number(operation.generation) !== generation) {
          return fail("OPERATION_CORRELATION_OPERATION_MISMATCH");
        }

        const next = { provider, projectId, correlationHash, operationId, workId, generation, actorIdHash };
        const current = parseRow(getRow.get(provider, projectId, correlationHash));
        if (current) {
          if (sameCorrelation(current, next)) return { ok: true, correlation: current, replayed: true };
          return fail("OPERATION_CORRELATION_CONFLICT");
        }

        insert.run(provider, projectId, correlationHash, operationId, workId, generation, actorIdHash);
        return { ok: true, correlation: next, replayed: false };
      });
    },

    get({ provider, projectId, correlationHash } = {}) {
      if (!validKeyPart(provider) || !validKeyPart(projectId) || !HASH_PATTERN.test(correlationHash ?? "")) return null;
      return parseRow(getRow.get(provider, projectId, correlationHash));
    },
  });
}
