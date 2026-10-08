import { assertSchema, validateSchema } from '../schema/validator.mjs';

export const AUDIT_VERDICTS = Object.freeze({
  PASS: 'PASS',
  BLOCKING_FINDING: 'BLOCKING_FINDING',
});

export function validateAuditResult(result) {
  return validateSchema('audit-result.v1.schema.json', result);
}

export function assertAuditResult(result) {
  return assertSchema('audit-result.v1.schema.json', result);
}
