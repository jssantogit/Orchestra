import { assertSchema, validateSchema } from "../schema/validator.mjs";

export const DELEGATION_PURPOSES = Object.freeze({
  INDEPENDENT_REVIEW: "INDEPENDENT_REVIEW",
  SECOND_OPINION: "SECOND_OPINION",
  SPECIALIST_EXECUTION: "SPECIALIST_EXECUTION",
  MANUAL: "MANUAL",
});

export const DELEGATION_STATUSES = Object.freeze({
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  TIMED_OUT: "TIMED_OUT",
  DENIED: "DENIED",
});

export const DELEGATION_FAILURE_REASONS = Object.freeze({
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  CAPABILITY_DENIED: "CAPABILITY_DENIED",
  WORKSPACE_PREP_FAILED: "WORKSPACE_PREP_FAILED",
  EXECUTION_FAILED: "EXECUTION_FAILED",
  EXECUTION_TIMED_OUT: "EXECUTION_TIMED_OUT",
  INVALID_RESULT: "INVALID_RESULT",
  WORKSPACE_CLEANUP_FAILED: "WORKSPACE_CLEANUP_FAILED",
});

const REQUEST_SCHEMA = "delegation-request.v1.schema.json";
const RESULT_SCHEMA = "delegation-result.v1.schema.json";

export function validateDelegationRequest(request) {
  const result = validateSchema(REQUEST_SCHEMA, request);
  if (!result.valid) return result;
  if (request.taskId !== request.packet?.taskId) {
    return {
      valid: false,
      errors: [{ path: "/packet/taskId", keyword: "const", message: "must match request taskId" }],
    };
  }
  return result;
}

export function assertDelegationRequest(request) {
  const result = validateDelegationRequest(request);
  if (result.valid) return request;
  const error = new Error(`ORCHESTRA_SCHEMA_INVALID:${REQUEST_SCHEMA}`);
  error.code = "ORCHESTRA_SCHEMA_INVALID";
  error.schemaFile = REQUEST_SCHEMA;
  error.errors = result.errors;
  throw error;
}

export function validateDelegationResult(result) {
  return validateSchema(RESULT_SCHEMA, result);
}

export function assertDelegationResult(result) {
  return assertSchema(RESULT_SCHEMA, result);
}
