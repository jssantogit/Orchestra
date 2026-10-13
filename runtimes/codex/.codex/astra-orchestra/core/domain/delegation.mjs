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

export function validateDelegationRequest(value) {
  return validateSchema("delegation-request.v1.schema.json", value);
}

export function assertDelegationRequest(value) {
  return assertSchema("delegation-request.v1.schema.json", value);
}

export function validateDelegationResult(value) {
  return validateSchema("delegation-result.v1.schema.json", value);
}

export function assertDelegationResult(value) {
  return assertSchema("delegation-result.v1.schema.json", value);
}
