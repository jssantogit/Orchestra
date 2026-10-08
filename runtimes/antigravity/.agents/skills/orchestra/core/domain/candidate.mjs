import { assertSchema, validateSchema } from '../schema/validator.mjs';

export function validateCandidate(candidate) {
  return validateSchema('candidate.v1.schema.json', candidate);
}

export function assertCandidate(candidate) {
  return assertSchema('candidate.v1.schema.json', candidate);
}
