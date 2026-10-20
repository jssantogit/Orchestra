import { evaluateCutoverReadiness } from './readiness.mjs';
import { evaluateProviderFieldEvidence } from './field-evidence.mjs';

const TOP_LEVEL_KEYS = new Set([
  'schema',
  'version',
  'headSha',
  'runtimeImageId',
  'readiness',
  'providerFieldEvidence',
  'ci',
  'evidenceRefs',
]);
const CI_KEYS = new Set(['headSha', 'runId', 'ubuntuV2', 'windowsV2', 'v1Compatibility']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value, allowed) {
  return isObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function add(errors, value) {
  if (!errors.includes(value)) errors.push(value);
}

function isSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function isEvidenceRef(value) {
  return typeof value === 'string' && (
    /^sha256:[0-9a-f]{64}$/.test(value)
    || /^evidence:[a-z0-9][a-z0-9:._/-]{0,255}$/i.test(value)
    || /^github-actions:\d+$/.test(value)
  );
}

export function validateCutoverReleaseEvidence(record, {
  expectedHeadSha,
  expectedRuntimeImageId,
} = {}) {
  if (!isSha(expectedHeadSha)) throw new TypeError('expectedHeadSha must be a 40-character lowercase git SHA');
  if (typeof expectedRuntimeImageId !== 'string' || expectedRuntimeImageId.trim().length === 0) {
    throw new TypeError('expectedRuntimeImageId is required');
  }

  const errors = [];
  if (!onlyKeys(record, TOP_LEVEL_KEYS)) add(errors, 'shape');
  if (!isObject(record)) return Object.freeze({ valid: false, errors: Object.freeze(['record']) });
  if (record.schema !== 'orchestra.cutover-release-evidence.v2') add(errors, 'schema');
  if (record.version !== 1) add(errors, 'version');
  if (record.headSha !== expectedHeadSha) add(errors, 'headSha');
  if (record.runtimeImageId !== expectedRuntimeImageId) add(errors, 'runtimeImageId');

  let readiness = null;
  try {
    readiness = evaluateCutoverReadiness({
      expectedHeadSha,
      evidence: record.readiness,
    });
    if (!readiness.ready) add(errors, 'readiness');
  } catch {
    add(errors, 'readiness');
  }

  const providers = {};
  for (const provider of ['codex', 'antigravity']) {
    try {
      const result = evaluateProviderFieldEvidence({
        provider,
        expectedHeadSha,
        expectedRuntimeImageId,
        records: record.providerFieldEvidence?.[provider],
      });
      providers[provider] = result;
      if (!result.verified) add(errors, `providerFieldEvidence.${provider}`);
    } catch {
      add(errors, `providerFieldEvidence.${provider}`);
      providers[provider] = null;
    }
  }

  if (!onlyKeys(record.ci, CI_KEYS)) {
    add(errors, 'ci');
  } else {
    if (record.ci.headSha !== expectedHeadSha) add(errors, 'ci.headSha');
    if (!Number.isInteger(record.ci.runId) || record.ci.runId <= 0) add(errors, 'ci.runId');
    if (record.ci.ubuntuV2 !== true) add(errors, 'ci.ubuntuV2');
    if (record.ci.windowsV2 !== true) add(errors, 'ci.windowsV2');
    if (record.ci.v1Compatibility !== true) add(errors, 'ci.v1Compatibility');
  }

  if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.length === 0
    || record.evidenceRefs.some((value) => !isEvidenceRef(value))) {
    add(errors, 'evidenceRefs');
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    readiness,
    providers: Object.freeze(providers),
  });
}
