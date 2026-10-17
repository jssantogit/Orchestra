import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  validateOperationV2,
  validateProjectV2,
  validateWorkUnitV2,
} from "../../domain/contracts.mjs";
import { createOperationCorrelationStore } from "../../providers/operation-correlation-store.mjs";
import { createSessionObservationStore } from "../../providers/session-observation-store.mjs";

const CURRENT_SCHEMA_VERSION = 4;
const WORK_IDENTITY_FIELDS = new Set(["workId", "projectId", "taskId", "generation"]);

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

function activeWorkCorruptError(projectId, workId) {
  const error = new Error(`ORCHESTRA_ACTIVE_WORK_HEAD_CORRUPT:${projectId}:${workId}`);
  error.code = "ORCHESTRA_ACTIVE_WORK_HEAD_CORRUPT";
  error.projectId = projectId;
  error.workId = workId;
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

const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: "v2_initial_registry",
    apply(db) {
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
    },
  }),
  Object.freeze({
    version: 2,
    name: "v2_work_operations",
    apply(db) {
      db.exec(`
        CREATE TABLE work_units (
          work_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK (generation >= 0),
          runtime_image TEXT NOT NULL,
          instruction_epoch INTEGER NOT NULL CHECK (instruction_epoch >= 0),
          state TEXT NOT NULL,
          record_json TEXT NOT NULL,
          original_request_json TEXT NOT NULL,
          original_request_digest TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (work_id, project_id),
          FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT
        ) STRICT;

        CREATE TABLE work_transitions (
          work_id TEXT NOT NULL,
          transition_id TEXT NOT NULL,
          request_json TEXT NOT NULL,
          request_digest TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (work_id, transition_id),
          FOREIGN KEY (work_id) REFERENCES work_units(work_id) ON DELETE RESTRICT
        ) STRICT;

        CREATE TABLE operations (
          operation_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK (generation >= 0),
          kind TEXT NOT NULL,
          actor_ref TEXT NOT NULL,
          has_workspace_edit INTEGER NOT NULL CHECK (has_workspace_edit IN (0, 1)),
          workflow_state TEXT NOT NULL,
          liveness TEXT NOT NULL,
          heartbeat_at TEXT,
          runtime_owner_ref TEXT,
          workspace_ref TEXT,
          result_ref TEXT,
          record_json TEXT NOT NULL,
          original_request_json TEXT NOT NULL,
          original_request_digest TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT,
          FOREIGN KEY (work_id, project_id) REFERENCES work_units(work_id, project_id) ON DELETE RESTRICT
        ) STRICT;

        CREATE INDEX operations_live_work_idx
          ON operations(project_id, work_id, generation, liveness);
        CREATE INDEX operations_live_workspace_idx
          ON operations(project_id, workspace_ref, liveness, has_workspace_edit);
      `);
    },
  }),
  Object.freeze({
    version: 3,
    name: "v2_active_work_head",
    apply(db) {
      db.exec(`
        CREATE TABLE project_work_heads (
          project_id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL UNIQUE,
          revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT,
          FOREIGN KEY (work_id, project_id) REFERENCES work_units(work_id, project_id) ON DELETE RESTRICT
        ) STRICT;

        CREATE TABLE work_head_commands (
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
    },
  }),
  Object.freeze({
    version: 4,
    name: "v2_provider_observations_and_correlations",
    apply(db) {
      db.exec(`
        CREATE TABLE provider_session_observations (
          provider TEXT NOT NULL,
          project_id TEXT NOT NULL,
          actor_id_hash TEXT NOT NULL,
          observed_instruction_epoch INTEGER NOT NULL CHECK (observed_instruction_epoch >= 0),
          observed_work_id TEXT,
          observed_generation INTEGER CHECK (observed_generation >= 0),
          observed_at TEXT NOT NULL,
          PRIMARY KEY (provider, project_id, actor_id_hash),
          CHECK ((observed_work_id IS NULL) = (observed_generation IS NULL)),
          FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT,
          FOREIGN KEY (observed_work_id, project_id) REFERENCES work_units(work_id, project_id) ON DELETE RESTRICT
        ) STRICT;

        CREATE TABLE provider_operation_correlations (
          provider TEXT NOT NULL,
          project_id TEXT NOT NULL,
          correlation_hash TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          work_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK (generation >= 0),
          actor_id_hash TEXT NOT NULL,
          PRIMARY KEY (provider, project_id, correlation_hash),
          FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT,
          FOREIGN KEY (operation_id) REFERENCES operations(operation_id) ON DELETE RESTRICT,
          FOREIGN KEY (work_id, project_id) REFERENCES work_units(work_id, project_id) ON DELETE RESTRICT
        ) STRICT;

        CREATE INDEX provider_correlations_operation_idx
          ON provider_operation_correlations(operation_id);
      `);
    },
  }),
]);

function applyMigration(db, migration) {
  migration.apply(db);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO orchestra_migrations(version, name, applied_at) VALUES (?, ?, ?)")
    .run(migration.version, migration.name, now);
  db.exec(`PRAGMA user_version = ${migration.version}`);
}

function initializeSchema(db) {
  db.exec("PRAGMA foreign_keys = ON");
  transaction(db, () => {
    const row = db.prepare("PRAGMA user_version").get();
    const version = Number(row?.user_version ?? 0);
    if (version > CURRENT_SCHEMA_VERSION) throw schemaTooNewError(version);
    for (const migration of MIGRATIONS) {
      if (migration.version > version) applyMigration(db, migration);
    }
  });
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
        if (rootOwner) return fail("WORKSPACE_ALREADY_REGISTERED", { projectId: rootOwner.project_id });

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

function createWorkStore(db) {
  const getById = db.prepare("SELECT * FROM work_units WHERE work_id = ?");
  const getByProject = db.prepare("SELECT * FROM work_units WHERE project_id = ? AND work_id = ?");
  const getProject = db.prepare("SELECT * FROM projects WHERE project_id = ?");
  const getHead = db.prepare(`
    SELECT w.*
    FROM project_work_heads h
    JOIN work_units w ON w.work_id = h.work_id AND w.project_id = h.project_id
    WHERE h.project_id = ?
  `);
  const getHeadId = db.prepare("SELECT work_id FROM project_work_heads WHERE project_id = ?");
  const insertHead = db.prepare(`
    INSERT INTO project_work_heads(project_id, work_id, revision, created_at, updated_at)
    VALUES (?, ?, 0, ?, ?)
  `);
  const deleteHead = db.prepare("DELETE FROM project_work_heads WHERE project_id = ? AND work_id = ?");
  const getHeadCommand = db.prepare("SELECT * FROM work_head_commands WHERE project_id = ? AND command_id = ?");
  const insertHeadCommand = db.prepare(`
    INSERT INTO work_head_commands(project_id, command_id, request_json, request_digest, result_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const findLiveOperation = db.prepare(`
    SELECT operation_id FROM operations
    WHERE project_id = ? AND work_id = ? AND generation = ? AND liveness = 'LIVE'
    LIMIT 1
  `);
  const insertWork = db.prepare(`
    INSERT INTO work_units(
      work_id, project_id, task_id, generation, runtime_image, instruction_epoch,
      state, record_json, original_request_json, original_request_digest, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getTransition = db.prepare("SELECT * FROM work_transitions WHERE work_id = ? AND transition_id = ?");
  const insertTransition = db.prepare(`
    INSERT INTO work_transitions(work_id, transition_id, request_json, request_digest, result_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const updateWork = db.prepare(`
    UPDATE work_units
    SET generation = ?, state = ?, record_json = ?, updated_at = ?
    WHERE work_id = ? AND project_id = ? AND generation = ?
  `);

  function validateWorkForProject(workUnit) {
    if (!validateWorkUnitV2(workUnit).valid) return fail("WORK_INVALID");
    const project = getProject.get(workUnit.projectId);
    if (!project) return fail("PROJECT_NOT_FOUND");
    if (workUnit.runtimeImage !== project.runtime_image) return fail("RUNTIME_IMAGE_MISMATCH");
    if (workUnit.instructionEpoch !== Number(project.instruction_epoch)) return fail("INSTRUCTION_EPOCH_MISMATCH");
    return null;
  }

  function insertNewWork(workUnit, requestJson, digest, now) {
    insertWork.run(
      workUnit.workId,
      workUnit.projectId,
      workUnit.taskId,
      workUnit.generation,
      workUnit.runtimeImage,
      workUnit.instructionEpoch,
      workUnit.state,
      requestJson,
      requestJson,
      digest,
      now,
      now,
    );
  }

  return Object.freeze({
    open(workUnit) {
      const invalid = validateWorkForProject(workUnit);
      if (invalid) return invalid;
      const requestJson = canonicalJson(workUnit);
      const digest = requestDigest(workUnit);
      return transaction(db, () => {
        const existing = getById.get(workUnit.workId);
        if (existing) {
          if (existing.original_request_digest === digest && existing.original_request_json === requestJson) {
            return ok({ work: parseRecord(existing), replayed: true });
          }
          return fail("WORK_ID_CONFLICT");
        }
        const now = new Date().toISOString();
        insertNewWork(workUnit, requestJson, digest, now);
        return ok({ work: JSON.parse(requestJson), replayed: false });
      });
    },

    startCurrent(workUnit) {
      if (!validateWorkUnitV2(workUnit).valid) return fail("WORK_INVALID");
      const requestJson = canonicalJson(workUnit);
      const digest = requestDigest(workUnit);
      return transaction(db, () => {
        const project = getProject.get(workUnit.projectId);
        if (!project) return fail("PROJECT_NOT_FOUND");
        if (workUnit.runtimeImage !== project.runtime_image) return fail("RUNTIME_IMAGE_MISMATCH");
        if (workUnit.instructionEpoch !== Number(project.instruction_epoch)) return fail("INSTRUCTION_EPOCH_MISMATCH");
        const head = getHeadId.get(workUnit.projectId);
        if (head) {
          if (head.work_id === workUnit.workId) {
            const existing = getById.get(workUnit.workId);
            if (existing && existing.original_request_digest === digest && existing.original_request_json === requestJson) {
              return ok({ work: parseRecord(existing), replayed: true });
            }
          }
          return fail("ACTIVE_WORK_EXISTS", { currentWorkId: head.work_id });
        }
        if (getById.get(workUnit.workId)) return fail("WORK_ID_CONFLICT");
        const now = new Date().toISOString();
        insertNewWork(workUnit, requestJson, digest, now);
        insertHead.run(workUnit.projectId, workUnit.workId, now, now);
        return ok({ work: JSON.parse(requestJson), replayed: false });
      });
    },

    current(projectId) {
      const head = getHeadId.get(projectId);
      if (!head) return null;
      const row = getHead.get(projectId);
      if (!row) throw activeWorkCorruptError(projectId, head.work_id);
      return parseRecord(row);
    },

    read(projectId, workId) {
      return parseRecord(getByProject.get(projectId, workId));
    },

    transition({ projectId, workId, expectedGeneration, transitionId, patch } = {}) {
      if (typeof transitionId !== "string" || transitionId.length === 0 || !isRecord(patch)) {
        return fail("WORK_TRANSITION_INVALID");
      }
      const request = { projectId, workId, expectedGeneration, transitionId, patch };
      const requestJson = canonicalJson(request);
      const digest = requestDigest(request);
      return transaction(db, () => {
        const currentRow = getById.get(workId);
        if (!currentRow) return fail("WORK_NOT_FOUND");
        if (currentRow.project_id !== projectId) return fail("WORK_PROJECT_MISMATCH");
        const prior = getTransition.get(workId, transitionId);
        if (prior) {
          if (prior.request_digest !== digest || prior.request_json !== requestJson) return fail("IDEMPOTENCY_CONFLICT");
          return ok({ work: JSON.parse(prior.result_json), replayed: true });
        }
        const current = parseRecord(currentRow);
        if (expectedGeneration !== current.generation) {
          return fail("STALE_GENERATION", { currentGeneration: current.generation });
        }
        if (Object.keys(patch).some((key) => WORK_IDENTITY_FIELDS.has(key))) return fail("IMMUTABLE_WORK_IDENTITY");
        const next = { ...current, ...structuredClone(patch), generation: current.generation + 1 };
        if (!validateWorkUnitV2(next).valid) return fail("WORK_TRANSITION_INVALID");
        const project = getProject.get(projectId);
        if (!project) return fail("PROJECT_NOT_FOUND");
        if (next.runtimeImage !== project.runtime_image) return fail("RUNTIME_IMAGE_MISMATCH");
        if (next.instructionEpoch !== Number(project.instruction_epoch)) return fail("INSTRUCTION_EPOCH_MISMATCH");
        const nextJson = canonicalJson(next);
        const now = new Date().toISOString();
        const update = updateWork.run(next.generation, next.state, nextJson, now, workId, projectId, expectedGeneration);
        if (Number(update.changes) !== 1) {
          const latest = getById.get(workId);
          return fail("STALE_GENERATION", { currentGeneration: Number(latest?.generation ?? -1) });
        }
        insertTransition.run(workId, transitionId, requestJson, digest, nextJson, now);
        return ok({ work: next, replayed: false });
      });
    },

    abandonCurrent({ projectId, expectedWorkId, expectedGeneration, commandId, reason } = {}) {
      if (typeof projectId !== "string" || typeof expectedWorkId !== "string"
        || !Number.isInteger(expectedGeneration) || expectedGeneration < 0
        || typeof commandId !== "string" || commandId.length === 0
        || typeof reason !== "string" || reason.trim().length === 0) {
        return fail("WORK_ABANDON_INVALID");
      }
      const request = { projectId, expectedWorkId, expectedGeneration, commandId, reason };
      const requestJson = canonicalJson(request);
      const digest = requestDigest(request);
      return transaction(db, () => {
        const prior = getHeadCommand.get(projectId, commandId);
        if (prior) {
          if (prior.request_digest !== digest || prior.request_json !== requestJson) return fail("IDEMPOTENCY_CONFLICT");
          return ok({ work: JSON.parse(prior.result_json), replayed: true });
        }
        const head = getHeadId.get(projectId);
        if (!head) return fail("NO_ACTIVE_WORK");
        if (head.work_id !== expectedWorkId) return fail("STALE_ACTIVE_WORK", { currentWorkId: head.work_id });
        const currentRow = getById.get(head.work_id);
        if (!currentRow || currentRow.project_id !== projectId) return fail("ACTIVE_WORK_CORRUPT");
        const current = parseRecord(currentRow);
        if (current.generation !== expectedGeneration) {
          return fail("STALE_GENERATION", { currentGeneration: current.generation });
        }
        const live = findLiveOperation.get(projectId, current.workId, current.generation);
        if (live) return fail("LIVE_OPERATION_EXISTS", { operationId: live.operation_id });
        const next = { ...current, state: "ABANDONED", generation: current.generation + 1 };
        if (!validateWorkUnitV2(next).valid) return fail("WORK_ABANDON_INVALID");
        const nextJson = canonicalJson(next);
        const now = new Date().toISOString();
        const update = updateWork.run(next.generation, next.state, nextJson, now, current.workId, projectId, expectedGeneration);
        if (Number(update.changes) !== 1) {
          const latest = getById.get(current.workId);
          return fail("STALE_GENERATION", { currentGeneration: Number(latest?.generation ?? -1) });
        }
        const deleted = deleteHead.run(projectId, current.workId);
        if (Number(deleted.changes) !== 1) {
          const error = new Error("ORCHESTRA_ACTIVE_WORK_HEAD_CHANGED");
          error.code = "ORCHESTRA_ACTIVE_WORK_HEAD_CHANGED";
          throw error;
        }
        insertHeadCommand.run(projectId, commandId, requestJson, digest, nextJson, now);
        return ok({ work: next, replayed: false });
      });
    },
  });
}

function createOperationStore(db) {
  const getById = db.prepare("SELECT * FROM operations WHERE operation_id = ?");
  const getWork = db.prepare("SELECT * FROM work_units WHERE work_id = ?");
  const getProject = db.prepare("SELECT * FROM projects WHERE project_id = ?");
  const findLiveWriter = db.prepare(`
    SELECT operation_id FROM operations
    WHERE project_id = ? AND workspace_ref = ? AND liveness = 'LIVE' AND has_workspace_edit = 1
    LIMIT 1
  `);
  const insertOperation = db.prepare(`
    INSERT INTO operations(
      operation_id, project_id, work_id, generation, kind, actor_ref, has_workspace_edit,
      workflow_state, liveness, heartbeat_at, runtime_owner_ref, workspace_ref, result_ref,
      record_json, original_request_json, original_request_digest, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateHeartbeat = db.prepare(`
    UPDATE operations SET heartbeat_at = ?, record_json = ?, updated_at = ? WHERE operation_id = ?
  `);
  const updateTerminal = db.prepare(`
    UPDATE operations
    SET workflow_state = ?, liveness = 'TERMINAL', result_ref = ?, record_json = ?, updated_at = ?
    WHERE operation_id = ? AND liveness != 'TERMINAL'
  `);
  const listLiveByProject = db.prepare("SELECT * FROM operations WHERE project_id = ? AND liveness = 'LIVE'");

  return Object.freeze({
    begin({ expectedGeneration, operation } = {}) {
      if (!validateOperationV2(operation).valid) return fail("OPERATION_INVALID");
      const request = { expectedGeneration, operation };
      const requestJson = canonicalJson(request);
      const digest = requestDigest(request);
      return transaction(db, () => {
        const existing = getById.get(operation.operationId);
        if (existing) {
          if (existing.original_request_digest === digest && existing.original_request_json === requestJson) {
            return ok({ operation: parseRecord(existing), replayed: true });
          }
          return fail("OPERATION_ID_CONFLICT");
        }
        if (operation.liveness !== "LIVE") return fail("OPERATION_BEGIN_NOT_LIVE");
        const hasWorkspaceEdit = operation.capabilities.includes("WORKSPACE_EDIT");
        if (hasWorkspaceEdit && !operation.workspaceRef) return fail("MUTATION_WORKSPACE_REQUIRED");
        const currentWork = getWork.get(operation.workId);
        if (!currentWork) return fail("WORK_NOT_FOUND");
        if (operation.projectId !== currentWork.project_id) return fail("OPERATION_PROJECT_MISMATCH");
        if (!getProject.get(operation.projectId)) return fail("PROJECT_NOT_FOUND");
        if (expectedGeneration !== Number(currentWork.generation)) {
          return fail("STALE_GENERATION", { currentGeneration: Number(currentWork.generation) });
        }
        if (operation.generation !== Number(currentWork.generation)) {
          return fail("OPERATION_GENERATION_MISMATCH", { currentGeneration: Number(currentWork.generation) });
        }
        if (hasWorkspaceEdit) {
          const incompatible = findLiveWriter.get(operation.projectId, operation.workspaceRef);
          if (incompatible) return fail("INCOMPATIBLE_LIVE_OPERATION", { operationId: incompatible.operation_id });
        }
        const recordJson = canonicalJson(operation);
        const now = new Date().toISOString();
        insertOperation.run(
          operation.operationId, operation.projectId, operation.workId, operation.generation,
          operation.kind, operation.actorRef, hasWorkspaceEdit ? 1 : 0, operation.workflowState,
          operation.liveness, operation.heartbeatAt, operation.runtimeOwnerRef, operation.workspaceRef,
          operation.resultRef, recordJson, requestJson, digest, now, now,
        );
        return ok({ operation: JSON.parse(recordJson), replayed: false });
      });
    },

    inspect(operationId) {
      return parseRecord(getById.get(operationId));
    },

    listLive({ projectId, workId = null, generation = null } = {}) {
      return listLiveByProject.all(projectId)
        .filter((row) => workId === null || row.work_id === workId)
        .filter((row) => generation === null || Number(row.generation) === generation)
        .map(parseRecord);
    },

    heartbeat({ operationId, runtimeOwnerRef, heartbeatAt } = {}) {
      return transaction(db, () => {
        const currentRow = getById.get(operationId);
        if (!currentRow) return fail("OPERATION_NOT_FOUND");
        const current = parseRecord(currentRow);
        if (current.liveness === "TERMINAL") return fail("OPERATION_TERMINAL");
        if (current.runtimeOwnerRef !== runtimeOwnerRef) return fail("OWNER_PROOF_MISMATCH");
        const previousHeartbeat = current.heartbeatAt ? Date.parse(current.heartbeatAt) : Number.NEGATIVE_INFINITY;
        const nextHeartbeat = Date.parse(heartbeatAt);
        if (!Number.isFinite(nextHeartbeat)) return fail("HEARTBEAT_INVALID");
        if (nextHeartbeat < previousHeartbeat) return fail("STALE_HEARTBEAT");
        const next = { ...current, heartbeatAt };
        if (!validateOperationV2(next).valid) return fail("HEARTBEAT_INVALID");
        const now = new Date().toISOString();
        updateHeartbeat.run(heartbeatAt, canonicalJson(next), now, operationId);
        return ok({ operation: next });
      });
    },

    terminalize({ operationId, workflowState, resultRef } = {}) {
      return transaction(db, () => {
        const currentRow = getById.get(operationId);
        if (!currentRow) return fail("OPERATION_NOT_FOUND");
        const current = parseRecord(currentRow);
        if (current.liveness === "TERMINAL") {
          if (current.workflowState === workflowState && current.resultRef === resultRef) {
            return ok({ operation: current, replayed: true });
          }
          return fail("TERMINAL_RESULT_CONFLICT");
        }
        const next = { ...current, workflowState, liveness: "TERMINAL", resultRef };
        if (!validateOperationV2(next).valid) return fail("TERMINAL_RESULT_INVALID");
        const now = new Date().toISOString();
        const update = updateTerminal.run(workflowState, resultRef, canonicalJson(next), now, operationId);
        if (Number(update.changes) !== 1) {
          const latest = parseRecord(getById.get(operationId));
          if (latest?.liveness === "TERMINAL" && latest.workflowState === workflowState && latest.resultRef === resultRef) {
            return ok({ operation: latest, replayed: true });
          }
          return fail("TERMINAL_RESULT_CONFLICT");
        }
        return ok({ operation: next, replayed: false });
      });
    },
  });
}

export function createSqliteState({ dbPath, timeoutMs = 5_000 } = {}) {
  if (typeof dbPath !== "string" || dbPath.length === 0) throw new TypeError("dbPath is required");
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath, { timeout: timeoutMs });
  try {
    initializeSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const projects = createProjectRegistry(db);
  const work = createWorkStore(db);
  const operations = createOperationStore(db);
  const sessionObservations = createSessionObservationStore(db);
  const operationCorrelations = createOperationCorrelationStore(db);
  let closed = false;

  return Object.freeze({
    projects,
    work,
    operations,
    sessionObservations,
    operationCorrelations,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    close() {
      if (closed) return;
      db.close();
      closed = true;
    },
  });
}
