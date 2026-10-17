function clone(value) {
  return value == null ? value : structuredClone(value);
}

function matches(operation, { projectId, workId = null, generation = null, liveness = null } = {}) {
  if (!operation || operation.projectId !== projectId) return false;
  if (workId !== null && operation.workId !== workId) return false;
  if (generation !== null && operation.generation !== generation) return false;
  if (liveness !== null && operation.liveness !== liveness) return false;
  return true;
}

export function trackOperationListing(state) {
  if (!state?.operations?.begin || !state?.operations?.inspect) {
    throw new TypeError("state.operations begin/inspect is required");
  }
  const underlying = state.operations;
  const operationIds = new Set();

  const operations = Object.freeze({
    ...underlying,
    begin(command) {
      const result = underlying.begin(command);
      if (result?.ok && result.operation?.operationId) operationIds.add(result.operation.operationId);
      return result;
    },
    list(query = {}) {
      return [...operationIds]
        .map((operationId) => underlying.inspect(operationId))
        .filter((operation) => matches(operation, query))
        .map(clone);
    },
  });

  return Object.freeze({ ...state, operations });
}
