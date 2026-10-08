import implementationPacket from './generated/implementation-packet.v1.mjs';
import scopeContract from './generated/scope-contract.v2.mjs';
import candidate from './generated/candidate.v1.mjs';
import evidence from './generated/evidence.v1.mjs';
import auditResult from './generated/audit-result.v1.mjs';
import workLease from './generated/work-lease.v1.mjs';
import runtimeEvent from './generated/runtime-event.v1.mjs';

const validators = new Map([
  ['implementation-packet.v1.schema.json', implementationPacket],
  ['scope-contract.v2.schema.json', scopeContract],
  ['candidate.v1.schema.json', candidate],
  ['evidence.v1.schema.json', evidence],
  ['audit-result.v1.schema.json', auditResult],
  ['work-lease.v1.schema.json', workLease],
  ['runtime-event.v1.schema.json', runtimeEvent],
]);

function compactErrors(errors = []) {
  return errors.map((error) => ({
    path: error.instancePath || '/',
    keyword: error.keyword,
    message: error.message || 'invalid',
  }));
}

export function validateSchema(schemaFile, value) {
  const validator = validators.get(schemaFile);
  if (!validator) {
    return { valid: false, errors: [{ path: '/', keyword: 'schema', message: `unknown schema ${schemaFile}` }] };
  }
  const valid = Boolean(validator(value));
  return { valid, errors: valid ? [] : compactErrors(validator.errors) };
}

export function assertSchema(schemaFile, value) {
  const result = validateSchema(schemaFile, value);
  if (!result.valid) {
    const error = new Error(`ORCHESTRA_SCHEMA_INVALID:${schemaFile}`);
    error.errors = result.errors;
    throw error;
  }
  return value;
}
