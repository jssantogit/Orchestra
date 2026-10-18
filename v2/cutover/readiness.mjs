export const CUTOVER_EVIDENCE_STATUS = Object.freeze({
  VERIFIED: 'VERIFIED',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
});

const REQUIRED_TOP_LEVEL = Object.freeze([
  'registryPersistence',
  'providers',
  'runtimeLifecycle',
  'reconciliation',
  'experiencePrivacy',
  'rsiReplay',
  'migration',
  'platforms',
  'projects',
  'selfHost',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function addUnique(target, value) {
  if (!target.includes(value)) target.push(value);
}

function validateVerifiedRecord(record, path, expectedHeadSha, missing, invalid) {
  if (!isObject(record)) {
    addUnique(missing, path);
    return false;
  }
  let valid = true;
  if (record.status !== CUTOVER_EVIDENCE_STATUS.VERIFIED) {
    addUnique(invalid, `${path}:status`);
    valid = false;
  }
  if (record.headSha !== expectedHeadSha) {
    addUnique(invalid, `${path}:headSha`);
    valid = false;
  }
  return valid;
}

function requireFact(record, path, factName, invalid) {
  if (record?.facts?.[factName] !== true) {
    addUnique(invalid, `${path}:${factName}`);
    return false;
  }
  return true;
}

function requireNonEmptyString(record, path, factName, invalid) {
  const value = record?.facts?.[factName];
  if (typeof value !== 'string' || value.length === 0) {
    addUnique(invalid, `${path}:${factName}`);
    return false;
  }
  return true;
}

export function evaluateCutoverReadiness({ expectedHeadSha, evidence } = {}) {
  if (typeof expectedHeadSha !== 'string' || expectedHeadSha.length === 0) {
    throw new TypeError('expectedHeadSha is required');
  }

  const missing = [];
  const invalid = [];
  const input = isObject(evidence) ? evidence : {};

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in input)) addUnique(missing, key);
  }

  validateVerifiedRecord(
    input.registryPersistence,
    'registryPersistence',
    expectedHeadSha,
    missing,
    invalid,
  );

  if (!isObject(input.providers)) {
    if ('providers' in input) addUnique(invalid, 'providers:shape');
  } else {
    validateVerifiedRecord(
      input.providers.codex,
      'providers.codex',
      expectedHeadSha,
      missing,
      invalid,
    );
    validateVerifiedRecord(
      input.providers.antigravity,
      'providers.antigravity',
      expectedHeadSha,
      missing,
      invalid,
    );
  }

  if (validateVerifiedRecord(
    input.runtimeLifecycle,
    'runtimeLifecycle',
    expectedHeadSha,
    missing,
    invalid,
  )) {
    requireFact(input.runtimeLifecycle, 'runtimeLifecycle', 'installed', invalid);
    requireFact(input.runtimeLifecycle, 'runtimeLifecycle', 'pinned', invalid);
    requireFact(input.runtimeLifecycle, 'runtimeLifecycle', 'rollbackVerified', invalid);
    requireNonEmptyString(input.runtimeLifecycle, 'runtimeLifecycle', 'runtimeImageId', invalid);
  }

  if (validateVerifiedRecord(
    input.reconciliation,
    'reconciliation',
    expectedHeadSha,
    missing,
    invalid,
  )) {
    requireFact(input.reconciliation, 'reconciliation', 'staleRecoveryVerified', invalid);
    requireFact(input.reconciliation, 'reconciliation', 'dirtyRecoveryVerified', invalid);
  }

  validateVerifiedRecord(
    input.experiencePrivacy,
    'experiencePrivacy',
    expectedHeadSha,
    missing,
    invalid,
  );

  if (validateVerifiedRecord(
    input.rsiReplay,
    'rsiReplay',
    expectedHeadSha,
    missing,
    invalid,
  )) {
    requireFact(input.rsiReplay, 'rsiReplay', 'trainVerified', invalid);
    requireFact(input.rsiReplay, 'rsiReplay', 'evaluateVerified', invalid);
    requireFact(input.rsiReplay, 'rsiReplay', 'holdoutVerified', invalid);
  }

  if (validateVerifiedRecord(
    input.migration,
    'migration',
    expectedHeadSha,
    missing,
    invalid,
  )) {
    requireFact(input.migration, 'migration', 'migrationVerified', invalid);
    requireFact(input.migration, 'migration', 'tsuzukiF7Verified', invalid);
  }

  if (!isObject(input.platforms)) {
    if ('platforms' in input) addUnique(invalid, 'platforms:shape');
  } else {
    validateVerifiedRecord(
      input.platforms.windows,
      'platforms.windows',
      expectedHeadSha,
      missing,
      invalid,
    );
    validateVerifiedRecord(
      input.platforms.posix,
      'platforms.posix',
      expectedHeadSha,
      missing,
      invalid,
    );
  }

  if (!Array.isArray(input.projects)) {
    if ('projects' in input) addUnique(invalid, 'projects:shape');
  } else {
    const verifiedProjects = [];
    for (let index = 0; index < input.projects.length; index += 1) {
      const path = `projects[${index}]`;
      const record = input.projects[index];
      if (validateVerifiedRecord(record, path, expectedHeadSha, missing, invalid)) {
        const projectId = record?.facts?.projectId;
        const lineageId = record?.facts?.lineageId;
        if (typeof projectId !== 'string' || projectId.length === 0) {
          addUnique(invalid, `${path}:projectId`);
        }
        if (typeof lineageId !== 'string' || lineageId.length === 0) {
          addUnique(invalid, `${path}:lineageId`);
        }
        if (record?.facts?.noFullLocalGovernanceRuntime !== true) {
          addUnique(invalid, 'projects:no-full-local-governance-runtime');
        }
        if (
          typeof projectId === 'string' && projectId.length > 0 &&
          typeof lineageId === 'string' && lineageId.length > 0
        ) {
          verifiedProjects.push({ projectId, lineageId });
        }
      }
    }

    const projectIds = new Set(verifiedProjects.map((item) => item.projectId));
    const lineageIds = new Set(verifiedProjects.map((item) => item.lineageId));
    if (projectIds.size < 2 || lineageIds.size < 2) {
      addUnique(invalid, 'projects:independent-lineages');
    }
  }

  if (validateVerifiedRecord(
    input.selfHost,
    'selfHost',
    expectedHeadSha,
    missing,
    invalid,
  )) {
    requireNonEmptyString(input.selfHost, 'selfHost', 'projectId', invalid);
    requireNonEmptyString(input.selfHost, 'selfHost', 'lineageId', invalid);
    requireNonEmptyString(input.selfHost, 'selfHost', 'runtimeImageId', invalid);
    if (input.selfHost?.facts?.noFullLocalGovernanceRuntime !== true) {
      addUnique(invalid, 'selfHost:no-full-local-governance-runtime');
    }
  }

  return Object.freeze({
    ready: missing.length === 0 && invalid.length === 0,
    code: missing.length === 0 && invalid.length === 0 ? 'CUTOVER_READY' : 'CUTOVER_NOT_READY',
    expectedHeadSha,
    missing: Object.freeze([...missing]),
    invalid: Object.freeze([...invalid]),
  });
}
