import { assertSchema, validateSchema } from "../schema/validator.mjs";

const SCHEMA = "scope-contract.v2.schema.json";

export function validateScopeContract(value) {
  return validateSchema(SCHEMA, value);
}

export function assertScopeContract(value) {
  return assertSchema(SCHEMA, value);
}
