import { assertSchema, validateSchema } from "../schema/validator.mjs";

const SCHEMA = "audit-result.v1.schema.json";

export function validateAuditResult(value) {
  return validateSchema(SCHEMA, value);
}

export function assertAuditResult(value) {
  return assertSchema(SCHEMA, value);
}
