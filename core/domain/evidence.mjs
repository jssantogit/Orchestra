import { assertSchema, validateSchema } from "../schema/validator.mjs";

const SCHEMA = "evidence.v1.schema.json";

export function validateEvidence(record) {
  return validateSchema(SCHEMA, record);
}

export function assertEvidence(record) {
  return assertSchema(SCHEMA, record);
}
