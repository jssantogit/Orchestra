import { assertSchema, validateSchema } from '../schema/validator.mjs';

export function validateEvidence(record) {
  return validateSchema('evidence.v1.schema.json', record);
}

export function assertEvidence(record) {
  return assertSchema('evidence.v1.schema.json', record);
}
