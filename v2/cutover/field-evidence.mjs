export const FIELD_TEST_SCENARIOS = Object.freeze([
  'ACTIVE_WORK_ATTACH',
  'NO_ACTIVE_WORK_INTAKE',
  'MUTATION_TERMINALIZATION',
  'STALE_EPOCH_DENIAL',
  'OWNER_LOSS_RECOVERY',
  'THIN_SHIM_ONLY',
]);

const SCENARIO_SET = new Set(FIELD_TEST_SCENARIOS);
const PROVIDERS = new Set(['codex', 'antigravity']);
const TERMINAL_STATUSES = new Set(['VERIFIED', 'FAILED', 'UNKNOWN']);
const TOP_LEVEL_KEYS = new Set([
  'schema',
  'version',
  'provider',
  'project',
  'runtimeImageId',
  'headSha',
  'scenarioId',
  'factualResult',
  'terminalStatus',
  'observedAt',
  'evidenceRefs',
  'operatorAttestation',
]);
const PROVIDER_KEYS = new Set(['family', 'version']);
const PROJECT_KEYS = new Set(['lineageId']);
const FACTUAL_RESULT_KEYS = new Set(['ok', 'code', 'factRef']);
const ATTESTATION_KEYS = new Set(['subjectHash', 'attestedAt']);
const FORBIDDEN_RAW_KEYS = new Set([
  'artifactBytes',
  'diff',
  'hiddenReasoning',
  'log',
  'logText',
  'patch',
  'prompt',
  'providerSessionId',
  'raw',
  'rawLog',
  'secret',
  'sessionId',
  'sourceCode',
  'token',
  'transcript',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pushUnique(target, value) {
  if (!target.includes(value)) target.push(value);
}

function hasOnlyKeys(value, allowed) {
  return isObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isSha256(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isEvidenceRef(value) {
  return typeof value === 'string' && (
    /^sha256:[0-9a-f]{64}$/.test(value)
    || /^evidence:[a-z0-9][a-z0-9:._/-]{0,255}$/i.test(value)
  );
}

function isFactCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(value);
}

function collectForbiddenRawKeys(value, errors, path = '') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbiddenRawKeys(item, errors, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_RAW_KEYS.has(key)) pushUnique(errors, nextPath);
    collectForbiddenRawKeys(nested, errors, nextPath);
  }
}

function validateProvider(provider, errors, expectedProvider) {
  if (!hasOnlyKeys(provider, PROVIDER_KEYS)) {
    pushUnique(errors, 'provider');
    return;
  }
  if (!PROVIDERS.has(provider.family)) pushUnique(errors, 'provider.family');
  if (typeof provider.version !== 'string' || provider.version.trim().length === 0 || provider.version.length > 128) {
    pushUnique(errors, 'provider.version');
  }
  if (expectedProvider !== null && provider.family !== expectedProvider) {
    pushUnique(errors, 'provider.family');
  }
}

function validateProject(project, errors) {
  if (!hasOnlyKeys(project, PROJECT_KEYS)) {
    pushUnique(errors, 'project');
    return;
  }
  if (typeof project.lineageId !== 'string' || project.lineageId.trim().length === 0 || project.lineageId.length > 256) {
    pushUnique(errors, 'project.lineageId');
  }
}

function validateFactualResult(result, errors) {
  if (!hasOnlyKeys(result, FACTUAL_RESULT_KEYS)) {
    pushUnique(errors, 'factualResult');
    return;
  }
  if (typeof result.ok !== 'boolean') pushUnique(errors, 'factualResult.ok');
  if (!isFactCode(result.code)) pushUnique(errors, 'factualResult.code');
  if (!isEvidenceRef(result.factRef)) pushUnique(errors, 'factualResult.factRef');
}

function validateAttestation(attestation, errors) {
  if (attestation === null || attestation === undefined) return;
  if (!hasOnlyKeys(attestation, ATTESTATION_KEYS)) {
    pushUnique(errors, 'operatorAttestation');
    return;
  }
  if (!isSha256(attestation.subjectHash)) pushUnique(errors, 'operatorAttestation.subjectHash');
  if (!isIsoTimestamp(attestation.attestedAt)) pushUnique(errors, 'operatorAttestation.attestedAt');
}

export function validateFieldEvidenceRecord(record, {
  expectedProvider = null,
  expectedHeadSha = null,
  expectedRuntimeImageId = null,
} = {}) {
  const errors = [];
  if (!hasOnlyKeys(record, TOP_LEVEL_KEYS)) {
    pushUnique(errors, 'shape');
  }
  if (!isObject(record)) {
    return Object.freeze({ valid: false, errors: Object.freeze(['record']) });
  }

  collectForbiddenRawKeys(record, errors);

  if (record.schema !== 'orchestra.cutover-field-evidence.v2') pushUnique(errors, 'schema');
  if (record.version !== 1) pushUnique(errors, 'version');

  if (expectedProvider !== null && !PROVIDERS.has(expectedProvider)) {
    throw new TypeError('expectedProvider must be codex or antigravity when provided');
  }
  validateProvider(record.provider, errors, expectedProvider);
  validateProject(record.project, errors);

  if (typeof record.runtimeImageId !== 'string' || record.runtimeImageId.trim().length === 0 || record.runtimeImageId.length > 256) {
    pushUnique(errors, 'runtimeImageId');
  }
  if (expectedRuntimeImageId !== null && record.runtimeImageId !== expectedRuntimeImageId) {
    pushUnique(errors, 'runtimeImageId');
  }

  if (typeof record.headSha !== 'string' || !/^[0-9a-f]{40}$/.test(record.headSha)) {
    pushUnique(errors, 'headSha');
  }
  if (expectedHeadSha !== null && record.headSha !== expectedHeadSha) {
    pushUnique(errors, 'headSha');
  }

  if (!SCENARIO_SET.has(record.scenarioId)) pushUnique(errors, 'scenarioId');
  validateFactualResult(record.factualResult, errors);
  if (!TERMINAL_STATUSES.has(record.terminalStatus)) pushUnique(errors, 'terminalStatus');
  if (record.terminalStatus === 'VERIFIED' && record.factualResult?.ok !== true) {
    pushUnique(errors, 'terminalStatus');
  }
  if (record.terminalStatus !== 'VERIFIED' && record.factualResult?.ok === true) {
    pushUnique(errors, 'terminalStatus');
  }
  if (!isIsoTimestamp(record.observedAt)) pushUnique(errors, 'observedAt');

  if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.length === 0
    || record.evidenceRefs.some((ref) => !isEvidenceRef(ref))) {
    pushUnique(errors, 'evidenceRefs');
  }

  validateAttestation(record.operatorAttestation, errors);

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze([...errors]),
  });
}

export function evaluateProviderFieldEvidence({
  provider,
  expectedHeadSha,
  expectedRuntimeImageId,
  records,
} = {}) {
  if (!PROVIDERS.has(provider)) throw new TypeError('provider must be codex or antigravity');
  if (typeof expectedHeadSha !== 'string' || !/^[0-9a-f]{40}$/.test(expectedHeadSha)) {
    throw new TypeError('expectedHeadSha must be a 40-character lowercase git SHA');
  }
  if (typeof expectedRuntimeImageId !== 'string' || expectedRuntimeImageId.trim().length === 0) {
    throw new TypeError('expectedRuntimeImageId is required');
  }
  if (!Array.isArray(records)) throw new TypeError('records must be an array');

  const seen = new Map();
  const invalidRecords = [];

  for (const record of records) {
    const scenarioId = SCENARIO_SET.has(record?.scenarioId) ? record.scenarioId : 'UNKNOWN_SCENARIO';
    const validation = validateFieldEvidenceRecord(record, {
      expectedProvider: provider,
      expectedHeadSha,
      expectedRuntimeImageId,
    });
    if (!validation.valid || record?.terminalStatus !== 'VERIFIED' || record?.factualResult?.ok !== true) {
      pushUnique(invalidRecords, scenarioId);
      continue;
    }
    if (seen.has(scenarioId)) {
      pushUnique(invalidRecords, scenarioId);
      continue;
    }
    seen.set(scenarioId, record);
  }

  const missingScenarios = FIELD_TEST_SCENARIOS.filter((scenarioId) => !seen.has(scenarioId));
  return Object.freeze({
    verified: missingScenarios.length === 0 && invalidRecords.length === 0,
    provider,
    expectedHeadSha,
    expectedRuntimeImageId,
    missingScenarios: Object.freeze(missingScenarios),
    invalidRecords: Object.freeze(invalidRecords),
  });
}
