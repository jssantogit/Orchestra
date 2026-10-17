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
    actorIdHash: row.actor_id_hash,
    observedInstructionEpoch: Number(row.observed_instruction_epoch),
    observedWorkId: row.observed_work_id,
    observedGeneration: row.observed_generation === null ? null : Number(row.observed_generation),
    observedAt: row.observed_at,
  };
}

function sameObservation(left, right) {
  return left.provider === right.provider
    && left.projectId === right.projectId
    && left.actorIdHash === right.actorIdHash
    && left.observedInstructionEpoch === right.observedInstructionEpoch
    && left.observedWorkId === right.observedWorkId
    && left.observedGeneration === right.observedGeneration
    && left.observedAt === right.observedAt;
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

export function createSessionObservationStore(db) {
  const getRow = db.prepare(`
    SELECT * FROM provider_session_observations
    WHERE provider = ? AND project_id = ? AND actor_id_hash = ?
  `);
  const getWork = db.prepare("SELECT project_id FROM work_units WHERE work_id = ?");
  const insert = db.prepare(`
    INSERT INTO provider_session_observations(
      provider, project_id, actor_id_hash, observed_instruction_epoch,
      observed_work_id, observed_generation, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE provider_session_observations
    SET observed_instruction_epoch = ?, observed_work_id = ?, observed_generation = ?, observed_at = ?
    WHERE provider = ? AND project_id = ? AND actor_id_hash = ?
  `);

  return Object.freeze({
    put(observation = {}) {
      const {
        provider, projectId, actorIdHash, observedInstructionEpoch,
        observedWorkId = null, observedGeneration = null, observedAt,
      } = observation;
      if (!validKeyPart(provider) || !validKeyPart(projectId) || !HASH_PATTERN.test(actorIdHash ?? "")
        || !Number.isSafeInteger(observedInstructionEpoch) || observedInstructionEpoch < 0
        || (observedWorkId !== null && !validKeyPart(observedWorkId))
        || (observedGeneration !== null && (!Number.isSafeInteger(observedGeneration) || observedGeneration < 0))
        || ((observedWorkId === null) !== (observedGeneration === null))
        || typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) {
        return fail("SESSION_OBSERVATION_INVALID");
      }

      return writeTransaction(db, () => {
        if (observedWorkId !== null) {
          const work = getWork.get(observedWorkId);
          if (!work) return fail("SESSION_OBSERVATION_WORK_NOT_FOUND");
          if (work.project_id !== projectId) return fail("SESSION_OBSERVATION_WORK_PROJECT_MISMATCH");
        }

        const current = parseRow(getRow.get(provider, projectId, actorIdHash));
        const next = {
          provider, projectId, actorIdHash, observedInstructionEpoch,
          observedWorkId, observedGeneration, observedAt,
        };
        if (current) {
          if (sameObservation(current, next)) return { ok: true, observation: current, replayed: true };
          const currentTime = Date.parse(current.observedAt);
          const nextTime = Date.parse(observedAt);
          if (nextTime <= currentTime) return fail("SESSION_OBSERVATION_CONFLICT");
          update.run(
            observedInstructionEpoch, observedWorkId, observedGeneration, observedAt,
            provider, projectId, actorIdHash,
          );
          return { ok: true, observation: next, replayed: false };
        }

        insert.run(provider, projectId, actorIdHash, observedInstructionEpoch, observedWorkId, observedGeneration, observedAt);
        return { ok: true, observation: next, replayed: false };
      });
    },

    get({ provider, projectId, actorIdHash } = {}) {
      if (!validKeyPart(provider) || !validKeyPart(projectId) || !HASH_PATTERN.test(actorIdHash ?? "")) return null;
      return parseRow(getRow.get(provider, projectId, actorIdHash));
    },
  });
}
