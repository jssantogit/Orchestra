import { validateSchema } from "../schema/validator.mjs";

export const DELEGATION_PURPOSES = Object.freeze({
  INDEPENDENT_REVIEW: "INDEPENDENT_REVIEW",
  SECOND_OPINION: "SECOND_OPINION",
  SPECIALIST_EXECUTION: "SPECIALIST_EXECUTION",
  MANUAL: "MANUAL",
  IMPLEMENTATION: "IMPLEMENTATION",
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
  SCOPE_VIOLATION: "SCOPE_VIOLATION",
  ARTIFACT_SEAL_FAILED: "ARTIFACT_SEAL_FAILED",
  ARTIFACT_TAMPERED: "ARTIFACT_TAMPERED",
  PROMOTION_STALE: "PROMOTION_STALE",
  PROMOTION_FAILED: "PROMOTION_FAILED",
});

const REQUEST_SCHEMAS = Object.freeze({
  "orchestra.delegation-request.v1": "delegation-request.v1.schema.json",
  "orchestra.delegation-request.v2": "delegation-request.v2.schema.json",
});
const RESULT_SCHEMAS = Object.freeze({
  "orchestra.delegation-result.v1": "delegation-result.v1.schema.json",
  "orchestra.delegation-result.v2": "delegation-result.v2.schema.json",
});

function unsupportedSchema(kind) {
  return {
    valid: false,
    errors: [{ path: "/schema", keyword: "enum", message: `unsupported delegation ${kind} schema` }],
  };
}

function schemaFileFor(value, schemas) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? schemas[value.schema] ?? null
    : null;
}

function assertValidation(kind, value, schemas, validate) {
  const schemaFile = schemaFileFor(value, schemas);
  const result = validate(value);
  if (result.valid) return value;
  const error = new Error(`ORCHESTRA_SCHEMA_INVALID:${schemaFile ?? `delegation-${kind}`}`);
  error.code = "ORCHESTRA_SCHEMA_INVALID";
  error.schemaFile = schemaFile;
  error.errors = result.errors;
  throw error;
}

export function validateDelegationRequest(request) {
  const schemaFile = schemaFileFor(request, REQUEST_SCHEMAS);
  if (!schemaFile) return unsupportedSchema("request");
  const result = validateSchema(schemaFile, request);
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
  return assertValidation("request", request, REQUEST_SCHEMAS, validateDelegationRequest);
}

export function validateDelegationResult(result) {
  const schemaFile = schemaFileFor(result, RESULT_SCHEMAS);
  if (!schemaFile) return unsupportedSchema("result");
  return validateSchema(schemaFile, result);
}

export function assertDelegationResult(result) {
  return assertValidation("result", result, RESULT_SCHEMAS, validateDelegationResult);
}
