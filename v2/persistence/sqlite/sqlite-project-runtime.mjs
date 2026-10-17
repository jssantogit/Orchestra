import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { validateProjectV2 } from "../../domain/contracts.mjs";

const COMMAND_SCHEMA_VERSION = 1;

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

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

function initializeCommandJournal(db) {
  transaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_runtime_command_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS project_runtime_commands (
        project_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, command_id),
        FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT
      ) STRICT;
    `);
    const meta = db.prepare("SELECT schema_version FROM project_runtime_command_meta WHERE singleton = 1").get();
    if (meta && Number(meta.schema_version) !== COMMAND_SCHEMA_VERSION) {
      const error = new Error(`ORCHESTRA_PROJECT_RUNTIME_COMMAND_SCHEMA_UNSUPPORTED:${meta.schema_version}`);
      error.code = "ORCHESTRA_PROJECT_RUNTIME_COMMAND_SCHEMA_UNSUPPORTED";
      error.schemaVersion = Number(meta.schema_version);
      error.supportedSchemaVersion = COMMAND_SCHEMA_VERSION;
      throw error;
    }
    if (!meta) {
      db.prepare("INSERT INTO project_runtime_command_meta(singleton, schema_version) VALUES (1, ?)")
        .run(COMMAND_SCHEMA_VERSION);
    }
  });
}

export function withSqliteProjectRuntimeUpdates(state, { dbPath, timeoutMs = 5_000 } = {}) {
  if (!state?.projects?.inspect) throw new TypeError("state.projects.inspect is required");
  if (dbPath === ":memory:") return state;
  if (typeof dbPath !== "string" || dbPath.length === 0) throw new TypeError("dbPath is required");

  const db = new DatabaseSync(dbPath, { timeout: timeoutMs });
  try {
    initializeCommandJournal(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const getProject = db.prepare("SELECT * FROM projects WHERE project_id = ?");
  const getCommand = db.prepare(`
    SELECT request_json, request_digest, result_json
    FROM project_runtime_commands
    WHERE project_id = ? AND command_id = ?
  `);
  const insertCommand = db.prepare(`
    INSERT INTO project_runtime_commands(
      project_id, command_id, request_json, request_digest, result_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
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
    updateRuntime({ projectId, expectedPinnedImage, expectedInstructionEpoch, targetImage, commandId } = {}) {
      assertOpen();
      if (typeof projectId !== "string" || projectId.length === 0
        || typeof expectedPinnedImage !== "string" || expectedPinnedImage.length === 0
        || !Number.isSafeInteger(expectedInstructionEpoch) || expectedInstructionEpoch < 0
        || typeof targetImage !== "string" || targetImage.length === 0
        || typeof commandId !== "string" || commandId.length === 0) {
        return fail("PROJECT_RUNTIME_UPDATE_INVALID");
      }

      const request = { projectId, targetImage, commandId };
      const requestJson = canonicalJson(request);
      const requestDigest = digest(requestJson);

      return transaction(db, () => {
        const prior = getCommand.get(projectId, commandId);
        if (prior) {
          if (prior.request_json !== requestJson || prior.request_digest !== requestDigest) {
            return fail("IDEMPOTENCY_CONFLICT");
          }
          const result = JSON.parse(prior.result_json);
          return { ...result, replayed: true };
        }

        const row = getProject.get(projectId);
        if (!row) return fail("PROJECT_NOT_FOUND");
        const currentPinnedImage = row.runtime_image;
        const currentInstructionEpoch = Number(row.instruction_epoch);
        const current = parseProject(row);

        if (currentPinnedImage === targetImage) {
          const result = { ok: true, project: current, replayed: true };
          insertCommand.run(
            projectId,
            commandId,
            requestJson,
            requestDigest,
            canonicalJson(result),
            new Date().toISOString(),
          );
          return result;
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

        const now = new Date().toISOString();
        const updated = updateProject.run(
          targetImage,
          next.runtime.instructionEpoch,
          canonicalJson(next),
          now,
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
        const result = { ok: true, project: next, replayed: false };
        insertCommand.run(
          projectId,
          commandId,
          requestJson,
          requestDigest,
          canonicalJson(result),
          now,
        );
        return result;
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
