import { DatabaseSync } from "node:sqlite";

import { validateOperationV2 } from "../../domain/contracts.mjs";

function success(payload = {}) {
  return { ok: true, ...payload };
}

function failure(reason, payload = {}) {
  return { ok: false, reason, ...payload };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalValue(value[key]);
  return output;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sameTerminalResult(operation, { workflowState, resultRef }) {
  return operation.workflowState === workflowState && operation.resultRef === resultRef;
}

function rollbackQuietly(db) {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Preserve the original transaction failure.
  }
}

export function fenceSqliteOperationTerminalization(state, {
  dbPath,
  timeoutMs = 5_000,
  now = () => new Date().toISOString(),
} = {}) {
  if (!state?.operations?.terminalize || !state?.operations?.inspect) {
    throw new TypeError("state.operations terminalize/inspect is required");
  }
  if (typeof dbPath !== "string" || dbPath.length === 0) throw new TypeError("dbPath is required");
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const underlying = state.operations;
  const operations = Object.freeze({
    ...underlying,
    terminalize(command = {}) {
      if (!Object.prototype.hasOwnProperty.call(command, "expectedHeartbeatAt") || dbPath === ":memory:") {
        return underlying.terminalize(command);
      }

      const db = new DatabaseSync(dbPath, { timeout: timeoutMs });
      db.exec("PRAGMA foreign_keys = ON");
      try {
        db.exec("BEGIN IMMEDIATE");
        const row = db.prepare("SELECT record_json FROM operations WHERE operation_id = ?")
          .get(command.operationId);
        if (!row) {
          db.exec("COMMIT");
          return failure("OPERATION_NOT_FOUND");
        }

        let current;
        try {
          current = JSON.parse(row.record_json);
        } catch {
          const error = new Error(`ORCHESTRA_V2_OPERATION_CORRUPT:${command.operationId}`);
          error.code = "ORCHESTRA_V2_OPERATION_CORRUPT";
          error.operationId = command.operationId;
          throw error;
        }
        if (!validateOperationV2(current).valid) {
          const error = new Error(`ORCHESTRA_V2_OPERATION_CORRUPT:${command.operationId}`);
          error.code = "ORCHESTRA_V2_OPERATION_CORRUPT";
          error.operationId = command.operationId;
          throw error;
        }

        if (current.liveness === "TERMINAL") {
          db.exec("COMMIT");
          if (sameTerminalResult(current, command)) {
            return success({ operation: clone(current), replayed: true });
          }
          return failure("TERMINAL_RESULT_CONFLICT");
        }

        if (current.heartbeatAt !== command.expectedHeartbeatAt) {
          db.exec("COMMIT");
          return failure("OPERATION_CHANGED", { currentHeartbeatAt: current.heartbeatAt });
        }

        const next = {
          ...clone(current),
          workflowState: command.workflowState,
          liveness: "TERMINAL",
          resultRef: command.resultRef,
        };
        if (!validateOperationV2(next).valid) {
          db.exec("COMMIT");
          return failure("TERMINAL_RESULT_INVALID");
        }

        const updatedAt = now();
        const result = db.prepare(`
          UPDATE operations
          SET workflow_state = ?, liveness = ?, result_ref = ?, record_json = ?, updated_at = ?
          WHERE operation_id = ?
        `).run(
          next.workflowState,
          next.liveness,
          next.resultRef,
          canonicalJson(next),
          updatedAt,
          next.operationId,
        );
        if (Number(result.changes) !== 1) {
          throw new Error(`ORCHESTRA_V2_OPERATION_UPDATE_FAILED:${next.operationId}`);
        }
        db.exec("COMMIT");
        return success({ operation: clone(next), replayed: false });
      } catch (error) {
        rollbackQuietly(db);
        throw error;
      } finally {
        db.close();
      }
    },
  });

  return Object.freeze({ ...state, operations });
}
