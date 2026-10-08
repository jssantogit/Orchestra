import { assertSchema, validateSchema } from "../schema/validator.mjs";

const SCHEMA = "work-lease.v1.schema.json";

export function validateWorkLease(lease) {
  return validateSchema(SCHEMA, lease);
}

export function assertWorkLease(lease) {
  return assertSchema(SCHEMA, lease);
}
