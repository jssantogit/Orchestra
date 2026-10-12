import { assertSchema, validateSchema } from "../schema/validator.mjs";

const SCHEMA = "scope-contract.v2.schema.json";

export function validateScopeContract(contract) {
  return validateSchema(SCHEMA, contract);
}

export function assertScopeContract(contract) {
  return assertSchema(SCHEMA, contract);
}
