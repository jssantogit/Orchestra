import { DatabaseSync } from "node:sqlite";

import { validateProjectV2 } from "../../domain/contracts.mjs";

function fail(reason, fields = {}) {
  return { ok: false, reason, ...fields };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  const output = Object.create(null);
  for (const key of Object.keys(value).sort()) output[key] = canonicalValue(value[key]);
  return output;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function transaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  }
}

function parseProject(row) {
  if (!row) return null;
  return JSON.parse(row.record_json);
}

export function withSqliteProjectRuntimeUpdates(state, { dbPath, timeoutMs = 5_000 } = {}) {
  if (!state?.projects?.inspect) throw new TypeError("state.projects.inspect is required");
  if (dbPath === ":memory:") return state;
  if (typeof dbPath !== "string" || dbPath.length === 0) throw new TypeError("dbPath is required");

  const db = new DatabaseSync(dbPath, { timeout: timeoutMs });
  const getProject = db.prepare("SELECT * FROM projects WHERE project_id = ?");
  const updateProject = db.prepare(`
    UPDATE projects
    SET runtime_image = ?, instruction_epoch = ?, record_json = ?, revision = revision + 1, updated_at = ?
    WHERE project_id = ? AND runtime_image = ? AND instruction_epoch = ?
  `);
  let closed = false;

  function assertOpen() {
    if (closed) throw new Error("Project runtime update store is closed");
  }

  const projects = Object.freeze({
    ...state.projects,
    updateRuntime({ projectId, expectedPinnedImage, expectedInstructionEpoch, targetImage } = {}) {
      assertOpen();
      if (typeof projectId !== "string" || projectId.length === 0
        || typeof expectedPinnedImage !== "string" || expectedPinnedImage.length === 0
        || !Number.isSafeInteger(expectedInstructionEpoch) || expectedInstructionEpoch < 0
        || typeof targetImage !== "string" || targetImage.length === 0) {
        return fail("PROJECT_RUNTIME_UPDATE_INVALID");
      }

      return transaction(db, () => {
        const row = getProject.get(projectId);
        if (!row) return fail("PROJECT_NOT_FOUND");
        const currentPinnedImage = row.runtime_image;
        const currentInstructionEpoch = Number(row.instruction_epoch);
        const current = parseProject(row);

        if (currentPinnedImage === targetImage) {
          return { ok: true, project: current, replayed: true };
        }
        if (currentPinnedImage !== expectedPinnedImage || currentInstructionEpoch !== expectedInstructionEpoch) {
          return fail("STALE_PROJECT_RUNTIME", { currentPinnedImage, currentInstructionEpoch });
        }

        const next = {
          ...current,
          runtime: {
            ...current.runtime,
            pinnedImage: targetImage,
            instructionEpoch: currentInstructionEpoch + 1,
          },
        };
        if (!validateProjectV2(next).valid) return fail("PROJECT_INVALID");

        const updated = updateProject.run(
          targetImage,
          next.runtime.instructionEpoch,
          canonicalJson(next),
          new Date().toISOString(),
          projectId,
          expectedPinnedImage,
          expectedInstructionEpoch,
        );
        if (Number(updated.changes) !== 1) {
          const latest = getProject.get(projectId);
          return fail("STALE_PROJECT_RUNTIME", {
            currentPinnedImage: latest?.runtime_image ?? null,
            currentInstructionEpoch: latest ? Number(latest.instruction_epoch) : null,
          });
        }
        return { ok: true, project: next, replayed: false };
      });
    },
  });

  return Object.freeze({
    ...state,
    projects,
    close() {
      if (closed) return;
      db.close();
      closed = true;
      state.close();
    },
  });
}
