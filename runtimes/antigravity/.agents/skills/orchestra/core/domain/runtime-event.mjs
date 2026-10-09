import { assertSchema, validateSchema } from "../schema/validator.mjs";

const SCHEMA = "runtime-event.v1.schema.json";

export function validateRuntimeEvent(event) {
  return validateSchema(SCHEMA, event);
}

export function assertRuntimeEvent(event) {
  return assertSchema(SCHEMA, event);
}
