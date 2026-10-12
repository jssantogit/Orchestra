import validateAuditResult from "./generated/audit-result.v1.mjs";
import validateCandidate from "./generated/candidate.v1.mjs";
import validateEvidence from "./generated/evidence.v1.mjs";
import validateImplementationPacket from "./generated/implementation-packet.v1.mjs";
import validateRuntimeEvent from "./generated/runtime-event.v1.mjs";
import validateScopeContract from "./generated/scope-contract.v2.mjs";
import validateWorkLease from "./generated/work-lease.v1.mjs";

const validators = new Map([
  ["audit-result.v1.schema.json", validateAuditResult],
  ["candidate.v1.schema.json", validateCandidate],
  ["evidence.v1.schema.json", validateEvidence],
  ["implementation-packet.v1.schema.json", validateImplementationPacket],
  ["runtime-event.v1.schema.json", validateRuntimeEvent],
  ["scope-contract.v2.schema.json", validateScopeContract],
  ["work-lease.v1.schema.json", validateWorkLease],
]);

function compactErrors(errors = []) {
  return errors.map((error) => ({
    path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message || "schema validation failed",
  }));
}

export function validateSchema(schemaFile, value) {
  const validate = validators.get(schemaFile);
  if (!validate) {
    return {
      valid: false,
      errors: [{ path: "/", keyword: "schema", message: `unknown schema: ${schemaFile}` }],
    };
  }

  const valid = Boolean(validate(value));
  return { valid, errors: valid ? [] : compactErrors(validate.errors) };
}

export function assertSchema(schemaFile, value) {
  const result = validateSchema(schemaFile, value);
  if (result.valid) return value;
  const error = new Error(`ORCHESTRA_SCHEMA_INVALID:${schemaFile}`);
  error.code = "ORCHESTRA_SCHEMA_INVALID";
  error.schemaFile = schemaFile;
  error.errors = result.errors;
  throw error;
}
