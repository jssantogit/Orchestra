import { assertSchema, validateSchema } from '../schema/validator.mjs';

export function validateScopeContract(contract) {
  return validateSchema('scope-contract.v2.schema.json', contract);
}

export function assertScopeContract(contract) {
  return assertSchema('scope-contract.v2.schema.json', contract);
}
