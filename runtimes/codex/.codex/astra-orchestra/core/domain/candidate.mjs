import { assertSchema, validateSchema } from "../schema/validator.mjs";

const SCHEMA = "candidate.v1.schema.json";

export function validateCandidate(value) {
  return validateSchema(SCHEMA, value);
}

export function assertCandidate(value) {
  return assertSchema(SCHEMA, value);
}
