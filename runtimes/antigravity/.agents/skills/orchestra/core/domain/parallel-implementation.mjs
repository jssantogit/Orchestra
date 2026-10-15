import { normalizeMutationScope } from "../delegation/mutation-scope.mjs";
import { validateSchema } from "../schema/validator.mjs";

const SCHEMA_FILE = "parallel-implementation-group.v1.schema.json";

function error(path, keyword, message) {
  return { path, keyword, message };
}

export function validateParallelImplementationGroup(value) {
  const schemaResult = validateSchema(SCHEMA_FILE, value);
  if (!schemaResult.valid) return schemaResult;

  const errors = [];
  const memberIds = new Set();
  const targetProviders = new Set();

  for (let index = 0; index < value.members.length; index += 1) {
    const member = value.members[index];
    if (memberIds.has(member.memberId)) {
      errors.push(error(`/members/${index}/memberId`, "unique", "memberId must be unique within the group"));
    }
    memberIds.add(member.memberId);

    if (targetProviders.has(member.targetProvider)) {
      errors.push(error(`/members/${index}/targetProvider`, "unique", "targetProvider must be unique within the group"));
    }
    targetProviders.add(member.targetProvider);

    if (member.packet.taskId !== value.taskId) {
      errors.push(error(`/members/${index}/packet/taskId`, "const", "must match group taskId"));
    }
    if (member.packet.candidateGeneration !== value.generation) {
      errors.push(error(`/members/${index}/packet/candidateGeneration`, "const", "must match group generation"));
    }

    try {
      normalizeMutationScope(member.mutationScope);
    } catch {
      errors.push(error(`/members/${index}/mutationScope`, "format", "mutation scope is invalid"));
    }
  }

  return { valid: errors.length === 0, errors };
}

export function assertParallelImplementationGroup(value) {
  const result = validateParallelImplementationGroup(value);
  if (result.valid) return value;
  const failure = new Error("PARALLEL_IMPLEMENTATION_GROUP_INVALID");
  failure.code = "PARALLEL_IMPLEMENTATION_GROUP_INVALID";
  failure.schemaFile = SCHEMA_FILE;
  failure.errors = result.errors;
  throw failure;
}
