import { assertSchema, validateSchema } from "../schema/validator.mjs";

const SCHEMA = "candidate.v1.schema.json";

export function validateCandidate(candidate) {
  return validateSchema(SCHEMA, candidate);
}

export function assertCandidate(candidate) {
  return assertSchema(SCHEMA, candidate);
}
