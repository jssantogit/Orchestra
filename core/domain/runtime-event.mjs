import { assertSchema, validateSchema } from '../schema/validator.mjs';

export function validateRuntimeEvent(event) {
  return validateSchema('runtime-event.v1.schema.json', event);
}

export function assertRuntimeEvent(event) {
  return assertSchema('runtime-event.v1.schema.json', event);
}
