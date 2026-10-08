import { assertSchema, validateSchema } from "../schema/validator.mjs";

const SCHEMA = "runtime-event.v1.schema.json";

export function validateRuntimeEvent(value) {
  return validateSchema(SCHEMA, value);
}

export function assertRuntimeEvent(value) {
  return assertSchema(SCHEMA, value);
}
