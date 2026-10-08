import { assertSchema, validateSchema } from "../schema/validator.mjs";

const SCHEMA = "evidence.v1.schema.json";

export function validateEvidence(value) {
  return validateSchema(SCHEMA, value);
}

export function assertEvidence(value) {
  return assertSchema(SCHEMA, value);
}
