import { assertSchema, validateSchema } from '../schema/validator.mjs';

export function validateWorkLease(lease) {
  return validateSchema('work-lease.v1.schema.json', lease);
}

export function assertWorkLease(lease) {
  return assertSchema('work-lease.v1.schema.json', lease);
}
