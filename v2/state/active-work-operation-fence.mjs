import { validateOperationV2 } from "../domain/contracts.mjs";

function failure(reason, payload = {}) {
  return { ok: false, reason, ...payload };
}

function requireState(state) {
  if (!state?.work?.read || !state?.work?.current || !state?.operations?.begin
    || !state?.operations?.inspect || !state?.operations?.terminalize) {
    throw new TypeError("state with work/read/current and operations/begin/inspect/terminalize is required");
  }
  return state;
}

export function fenceOperationsToActiveWork(state) {
  const store = requireState(state);
  const underlying = store.operations;

  const operations = Object.freeze({
    ...underlying,
    begin(command) {
      const operation = command?.operation;
      if (!validateOperationV2(operation).valid) return underlying.begin(command);

      // Preserve begin idempotency/conflict semantics for an operation that already exists.
      if (underlying.inspect(operation.operationId)) return underlying.begin(command);

      // Let the underlying store preserve its more specific not-found/project-mismatch errors.
      if (!store.work.read(operation.projectId, operation.workId)) return underlying.begin(command);

      let current;
      try {
        current = store.work.current(operation.projectId);
      } catch (error) {
        if (error?.code === "ORCHESTRA_ACTIVE_WORK_HEAD_CORRUPT") {
          return failure("ACTIVE_WORK_CORRUPT");
        }
        throw error;
      }

      if (!current) return failure("NO_ACTIVE_WORK");
      if (current.workId !== operation.workId) {
        return failure("STALE_ACTIVE_WORK", { currentWorkId: current.workId });
      }

      return underlying.begin(command);
    },
    terminalize(command = {}) {
      if (Object.prototype.hasOwnProperty.call(command, "expectedHeartbeatAt")) {
        const current = underlying.inspect(command.operationId);
        if (current && current.liveness !== "TERMINAL" && current.heartbeatAt !== command.expectedHeartbeatAt) {
          return failure("OPERATION_CHANGED", { currentHeartbeatAt: current.heartbeatAt });
        }
      }
      return underlying.terminalize(command);
    },
  });

  return Object.freeze({ ...store, operations });
}
