import { assertSchema, validateSchema } from "../schema/validator.mjs";

const SCHEMA = "audit-result.v1.schema.json";

export function validateAuditResult(result) {
  return validateSchema(SCHEMA, result);
}

export function assertAuditResult(result) {
  return assertSchema(SCHEMA, result);
}
