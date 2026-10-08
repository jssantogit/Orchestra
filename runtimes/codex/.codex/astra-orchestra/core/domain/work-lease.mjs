import { assertSchema, validateSchema } from "../schema/validator.mjs";

const SCHEMA = "work-lease.v1.schema.json";

export function validateWorkLease(value) {
  return validateSchema(SCHEMA, value);
}

export function assertWorkLease(value) {
  return assertSchema(SCHEMA, value);
}
