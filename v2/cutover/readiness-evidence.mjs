import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { evaluateProviderFieldEvidence, FIELD_TEST_SCENARIOS } from './field-evidence.mjs';
import { CUTOVER_EVIDENCE_STATUS, evaluateCutoverReadiness } from './readiness.mjs';

export const CUTOVER_READINESS_FRAGMENT_SCHEMA = 'orchestra.cutover-readiness-fragment.v2';
export const CUTOVER_READINESS_FRAGMENT_VERSION = 1;
export const CUTOVER_READINESS_PROBE_MODULE_SCHEMA = 'orchestra.cutover-readiness-probe-module.v2';
export const CUTOVER_READINESS_COLLECTION_MODE = 'CANONICAL_GIT_PROBES';

const SCALAR_FAMILIES = Object.freeze([
  'registryPersistence',
  'runtimeLifecycle',
  'reconciliation',
  'experiencePrivacy',
  'rsiReplay',
  'migration',
  'selfHost',
]);
const PLATFORM_FAMILIES = Object.freeze(['windows', 'posix']);
const RECORD_KEYS = new Set(['status', 'headSha', 'runtimeImageId', 'facts', 'evidenceRefs']);
const FRAGMENT_KEYS = new Set([
  'schema',
  'version',
  'headSha',
  'runtimeImageId',
  'evidence',
  'evidenceRefs',
  'errors',
  'collectionMode',
  'probeSources',
]);
const EVIDENCE_KEYS = new Set([...SCALAR_FAMILIES, 'platforms', 'projects']);
const PROBE_DESCRIPTOR_KEYS = new Set(['modulePath', 'args']);
const PROBE_MANIFEST_KEYS = new Set(['schema', 'version', 'probes']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return isObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function addUnique(target, value) {
  if (!target.includes(value)) target.push(value);
}

function isSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function isRuntimeImageId(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

function isEvidenceRef(value) {
  return typeof value === 'string' && (
    /^sha256:[0-9a-f]{64}$/.test(value)
    || /^evidence:[a-z0-9][a-z0-9:._/-]{0,255}$/i.test(value)
    || /^github-actions:\d+$/.test(value)
  );
}

function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    const valid = value.every((item) => isJsonValue(item, seen));
    seen.delete(value);
    return valid;
  }
  if (!isObject(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function identity({ expectedHeadSha, expectedRuntimeImageId }) {
  if (!isSha(expectedHeadSha)) {
    throw new TypeError('expectedHeadSha must be a 40-character lowercase git SHA');
  }
  if (!isRuntimeImageId(expectedRuntimeImageId)) {
    throw new TypeError('expectedRuntimeImageId is required');
  }
  return { expectedHeadSha, expectedRuntimeImageId };
}

function clone(value) {
  return structuredClone(value);
}

function recordErrors(record, { expectedHeadSha, expectedRuntimeImageId }) {
  const errors = [];
  if (!hasOnlyKeys(record, RECORD_KEYS)) {
    addUnique(errors, 'shape');
    if (!isObject(record)) return errors;
  }
  if (record.status !== CUTOVER_EVIDENCE_STATUS.VERIFIED) addUnique(errors, 'status');
  if (record.headSha !== expectedHeadSha) addUnique(errors, 'headSha');
  if (record.runtimeImageId !== expectedRuntimeImageId) addUnique(errors, 'runtimeImageId');
  if (!isObject(record.facts)) addUnique(errors, 'facts');
  if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.length === 0
    || record.evidenceRefs.some((ref) => !isEvidenceRef(ref))) {
    addUnique(errors, 'evidenceRefs');
  }
  return errors;
}

function probeResultErrors(result, expected) {
  const errors = [];
  if (!isObject(result)) return ['result'];
  if (result.ok !== true) addUnique(errors, 'ok');
  if (result.headSha !== expected.expectedHeadSha) addUnique(errors, 'headSha');
  if (result.runtimeImageId !== expected.expectedRuntimeImageId) addUnique(errors, 'runtimeImageId');
  if (!isObject(result.facts)) addUnique(errors, 'facts');
  if (!Array.isArray(result.evidenceRefs) || result.evidenceRefs.length === 0
    || result.evidenceRefs.some((ref) => !isEvidenceRef(ref))) {
    addUnique(errors, 'evidenceRefs');
  }
  return errors;
}

function recordFromProbeResult(result, expected) {
  return Object.freeze({
    status: CUTOVER_EVIDENCE_STATUS.VERIFIED,
    headSha: expected.expectedHeadSha,
    runtimeImageId: expected.expectedRuntimeImageId,
    facts: clone(result.facts),
    evidenceRefs: Object.freeze([...new Set(result.evidenceRefs)]),
  });
}

async function runProbe({ path, probe, expected, errors }) {
  if (typeof probe !== 'function') {
    addUnique(errors, `${path}:probe`);
    return null;
  }
  let result;
  try {
    result = await probe(Object.freeze({
      expectedHeadSha: expected.expectedHeadSha,
      expectedRuntimeImageId: expected.expectedRuntimeImageId,
    }));
  } catch {
    addUnique(errors, `${path}:probe-error`);
    return null;
  }
  const invalid = probeResultErrors(result, expected);
  for (const error of invalid) addUnique(errors, `${path}:${error}`);
  return invalid.length === 0 ? recordFromProbeResult(result, expected) : null;
}

function collectRefs(evidence) {
  const refs = [];
  const visit = (record) => {
    if (!record) return;
    for (const ref of record.evidenceRefs ?? []) addUnique(refs, ref);
  };
  for (const family of SCALAR_FAMILIES) visit(evidence[family]);
  for (const platform of PLATFORM_FAMILIES) visit(evidence.platforms?.[platform]);
  for (const project of evidence.projects ?? []) visit(project);
  return refs;
}

export async function collectCutoverReadinessFragment({
  expectedHeadSha,
  expectedRuntimeImageId,
  probes = {},
} = {}) {
  const expected = identity({ expectedHeadSha, expectedRuntimeImageId });
  if (!isObject(probes)) throw new TypeError('probes must be an object');

  const evidence = {};
  const errors = [];

  for (const family of SCALAR_FAMILIES) {
    if (!Object.hasOwn(probes, family)) continue;
    const record = await runProbe({ path: family, probe: probes[family], expected, errors });
    if (record) evidence[family] = record;
  }

  if (Object.hasOwn(probes, 'platforms')) {
    if (!isObject(probes.platforms)) {
      addUnique(errors, 'platforms:probe');
    } else {
      const platforms = {};
      for (const platform of PLATFORM_FAMILIES) {
        if (!Object.hasOwn(probes.platforms, platform)) continue;
        const record = await runProbe({
          path: `platforms.${platform}`,
          probe: probes.platforms[platform],
          expected,
          errors,
        });
        if (record) platforms[platform] = record;
      }
      if (Object.keys(platforms).length > 0) evidence.platforms = Object.freeze(platforms);
    }
  }

  if (Object.hasOwn(probes, 'projects')) {
    if (!Array.isArray(probes.projects)) {
      addUnique(errors, 'projects:probe');
    } else {
      const projects = [];
      for (let index = 0; index < probes.projects.length; index += 1) {
        const record = await runProbe({
          path: `projects[${index}]`,
          probe: probes.projects[index],
          expected,
          errors,
        });
        if (record) projects.push(record);
      }
      if (projects.length > 0) evidence.projects = Object.freeze(projects);
    }
  }

  return Object.freeze({
    schema: CUTOVER_READINESS_FRAGMENT_SCHEMA,
    version: CUTOVER_READINESS_FRAGMENT_VERSION,
    headSha: expectedHeadSha,
    runtimeImageId: expectedRuntimeImageId,
    evidence: Object.freeze(evidence),
    evidenceRefs: Object.freeze(collectRefs(evidence)),
    errors: Object.freeze(errors),
  });
}

function git(repoRoot, args) {
  try {
    return {
      ok: true,
      stdout: execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }).trim(),
    };
  } catch {
    return { ok: false, stdout: '' };
  }
}

function probeFamilyPath(path) {
  return path.startsWith('projects[') ? 'projects' : path;
}

function resolveTrackedProbePath(repoRoot, modulePath) {
  if (typeof modulePath !== 'string' || modulePath.trim().length === 0 || isAbsolute(modulePath)) return null;
  const root = resolve(repoRoot);
  const absolute = resolve(root, modulePath);
  const fromRoot = relative(root, absolute);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return null;
  return { root, absolute, modulePath: fromRoot.split(sep).join('/') };
}

function sourceDigest(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

async function canonicalProbeExecutor({
  path,
  descriptor,
  repoRoot,
  expected,
  errors,
  sources,
}) {
  if (!hasOnlyKeys(descriptor, PROBE_DESCRIPTOR_KEYS)
    || typeof descriptor.modulePath !== 'string'
    || (descriptor.args !== undefined && !isJsonValue(descriptor.args))) {
    addUnique(errors, `${path}:probe-descriptor`);
    return null;
  }

  const resolvedPath = resolveTrackedProbePath(repoRoot, descriptor.modulePath);
  if (!resolvedPath) {
    addUnique(errors, `${path}:probe-descriptor`);
    return null;
  }

  const head = git(resolvedPath.root, ['rev-parse', 'HEAD']);
  if (!head.ok || head.stdout !== expected.expectedHeadSha) {
    addUnique(errors, `${path}:source-head`);
    return null;
  }

  const tracked = git(resolvedPath.root, ['ls-files', '--error-unmatch', '--', resolvedPath.modulePath]);
  if (!tracked.ok) {
    addUnique(errors, `${path}:source-untracked`);
    return null;
  }

  const dirty = git(resolvedPath.root, ['status', '--porcelain', '--untracked-files=all', '--', resolvedPath.modulePath]);
  if (!dirty.ok || dirty.stdout.length > 0) {
    addUnique(errors, `${path}:source-dirty`);
    return null;
  }

  const repositoryDirty = git(resolvedPath.root, ['status', '--porcelain', '--untracked-files=all']);
  if (!repositoryDirty.ok || repositoryDirty.stdout.length > 0) {
    addUnique(errors, `${path}:source-repo-dirty`);
    return null;
  }

  let digest;
  let module;
  try {
    digest = sourceDigest(resolvedPath.absolute);
    module = await import(`${pathToFileURL(resolvedPath.absolute).href}?orchestra_probe=${digest.slice('sha256:'.length)}`);
  } catch {
    addUnique(errors, `${path}:probe-module`);
    return null;
  }

  const manifest = module.readinessProbeManifest;
  const familyPath = probeFamilyPath(path);
  if (!hasOnlyKeys(manifest, PROBE_MANIFEST_KEYS)
    || manifest.schema !== CUTOVER_READINESS_PROBE_MODULE_SCHEMA
    || manifest.version !== 1
    || !isObject(manifest.probes)
    || typeof manifest.probes[familyPath] !== 'string'
    || manifest.probes[familyPath].trim().length === 0) {
    addUnique(errors, `${path}:probe-manifest`);
    return null;
  }

  const exportName = manifest.probes[familyPath];
  const executor = module[exportName];
  if (typeof executor !== 'function') {
    addUnique(errors, `${path}:probe-manifest`);
    return null;
  }

  sources[path] = Object.freeze({
    modulePath: resolvedPath.modulePath,
    exportName,
    sourceDigest: digest,
  });

  const args = descriptor.args === undefined ? {} : clone(descriptor.args);
  return async () => {
    const result = await executor(Object.freeze({
      expectedHeadSha: expected.expectedHeadSha,
      expectedRuntimeImageId: expected.expectedRuntimeImageId,
      args,
      probeSource: sources[path],
    }));
    if (!isObject(result)) return result;
    const refs = Array.isArray(result.evidenceRefs) ? [...result.evidenceRefs] : result.evidenceRefs;
    if (Array.isArray(refs) && !refs.includes(digest)) refs.push(digest);
    return { ...result, evidenceRefs: refs };
  };
}

async function resolveCanonicalProbes({ probes, repoRoot, expected, errors, sources }) {
  const resolvedProbes = {};

  for (const family of SCALAR_FAMILIES) {
    if (!Object.hasOwn(probes, family)) continue;
    const executor = await canonicalProbeExecutor({
      path: family,
      descriptor: probes[family],
      repoRoot,
      expected,
      errors,
      sources,
    });
    if (executor) resolvedProbes[family] = executor;
  }

  if (Object.hasOwn(probes, 'platforms')) {
    if (!isObject(probes.platforms)) {
      addUnique(errors, 'platforms:probe-descriptor');
    } else {
      const platforms = {};
      for (const platform of PLATFORM_FAMILIES) {
        if (!Object.hasOwn(probes.platforms, platform)) continue;
        const executor = await canonicalProbeExecutor({
          path: `platforms.${platform}`,
          descriptor: probes.platforms[platform],
          repoRoot,
          expected,
          errors,
          sources,
        });
        if (executor) platforms[platform] = executor;
      }
      if (Object.keys(platforms).length > 0) resolvedProbes.platforms = platforms;
    }
  }

  if (Object.hasOwn(probes, 'projects')) {
    if (!Array.isArray(probes.projects)) {
      addUnique(errors, 'projects:probe-descriptor');
    } else {
      const projects = [];
      for (let index = 0; index < probes.projects.length; index += 1) {
        const path = `projects[${index}]`;
        const executor = await canonicalProbeExecutor({
          path,
          descriptor: probes.projects[index],
          repoRoot,
          expected,
          errors,
          sources,
        });
        if (executor) projects.push(executor);
      }
      if (projects.length > 0) resolvedProbes.projects = projects;
    }
  }

  return resolvedProbes;
}

export async function collectCanonicalCutoverReadinessFragment({
  repoRoot,
  expectedHeadSha,
  expectedRuntimeImageId,
  probes = {},
} = {}) {
  const expected = identity({ expectedHeadSha, expectedRuntimeImageId });
  if (typeof repoRoot !== 'string' || repoRoot.trim().length === 0) {
    throw new TypeError('repoRoot is required');
  }
  if (!isObject(probes)) throw new TypeError('probes must be an object');

  const canonicalErrors = [];
  const probeSources = {};
  const resolvedProbes = await resolveCanonicalProbes({
    probes,
    repoRoot,
    expected,
    errors: canonicalErrors,
    sources: probeSources,
  });
  const fragment = await collectCutoverReadinessFragment({
    expectedHeadSha,
    expectedRuntimeImageId,
    probes: resolvedProbes,
  });
  const errors = [...fragment.errors];
  for (const error of canonicalErrors) addUnique(errors, error);

  return Object.freeze({
    ...fragment,
    collectionMode: CUTOVER_READINESS_COLLECTION_MODE,
    probeSources: Object.freeze(clone(probeSources)),
    errors: Object.freeze(errors),
  });
}

function validateFragment(fragment, expected, index, errors) {
  const prefix = `fragment[${index}]`;
  if (!hasOnlyKeys(fragment, FRAGMENT_KEYS)) {
    addUnique(errors, `${prefix}:shape`);
    return false;
  }
  let valid = true;
  if (fragment.schema !== CUTOVER_READINESS_FRAGMENT_SCHEMA) {
    addUnique(errors, `${prefix}:schema`);
    valid = false;
  }
  if (fragment.version !== CUTOVER_READINESS_FRAGMENT_VERSION) {
    addUnique(errors, `${prefix}:version`);
    valid = false;
  }
  if (fragment.headSha !== expected.expectedHeadSha) {
    addUnique(errors, `${prefix}:headSha`);
    valid = false;
  }
  if (fragment.runtimeImageId !== expected.expectedRuntimeImageId) {
    addUnique(errors, `${prefix}:runtimeImageId`);
    valid = false;
  }
  if (!hasOnlyKeys(fragment.evidence, EVIDENCE_KEYS)) {
    addUnique(errors, `${prefix}:evidence`);
    valid = false;
  }
  if (!Array.isArray(fragment.evidenceRefs) || fragment.evidenceRefs.some((ref) => !isEvidenceRef(ref))) {
    addUnique(errors, `${prefix}:evidenceRefs`);
    valid = false;
  }
  if (!Array.isArray(fragment.errors)) {
    addUnique(errors, `${prefix}:errors`);
    valid = false;
  }
  return valid;
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeRecord({ target, key, record, path, expected, errors }) {
  const invalid = recordErrors(record, expected);
  if (invalid.length > 0) {
    for (const error of invalid) addUnique(errors, `${path}:${error}`);
    return;
  }
  if (!Object.hasOwn(target, key)) {
    target[key] = clone(record);
    return;
  }
  if (!sameRecord(target[key], record)) {
    delete target[key];
    addUnique(errors, `${path}:conflict`);
  }
}

function providerEvaluation(provider, records, expected) {
  if (!Array.isArray(records)) {
    return Object.freeze({
      verified: false,
      provider,
      expectedHeadSha: expected.expectedHeadSha,
      expectedRuntimeImageId: expected.expectedRuntimeImageId,
      missingScenarios: Object.freeze([...FIELD_TEST_SCENARIOS]),
      invalidRecords: Object.freeze([]),
    });
  }
  return evaluateProviderFieldEvidence({
    provider,
    expectedHeadSha: expected.expectedHeadSha,
    expectedRuntimeImageId: expected.expectedRuntimeImageId,
    records,
  });
}

function providerRecord(records, expected) {
  const refs = [];
  for (const record of records) {
    if (isEvidenceRef(record?.factualResult?.factRef)) addUnique(refs, record.factualResult.factRef);
    for (const ref of record?.evidenceRefs ?? []) {
      if (isEvidenceRef(ref)) addUnique(refs, ref);
    }
  }
  return Object.freeze({
    status: CUTOVER_EVIDENCE_STATUS.VERIFIED,
    headSha: expected.expectedHeadSha,
    runtimeImageId: expected.expectedRuntimeImageId,
    facts: Object.freeze({
      runtimeImageId: expected.expectedRuntimeImageId,
      scenarioCount: FIELD_TEST_SCENARIOS.length,
    }),
    evidenceRefs: Object.freeze(refs),
  });
}

function withCollectorErrors(readiness, errors) {
  if (errors.length === 0) return readiness;
  const invalid = [...readiness.invalid];
  for (const error of errors) addUnique(invalid, `collector:${error}`);
  return Object.freeze({
    ...readiness,
    ready: false,
    code: 'CUTOVER_NOT_READY',
    invalid: Object.freeze(invalid),
  });
}

export function mergeCutoverReadinessEvidence({
  expectedHeadSha,
  expectedRuntimeImageId,
  fragments = [],
  providerFieldEvidence = {},
} = {}) {
  const expected = identity({ expectedHeadSha, expectedRuntimeImageId });
  if (!Array.isArray(fragments)) throw new TypeError('fragments must be an array');
  if (!isObject(providerFieldEvidence)) throw new TypeError('providerFieldEvidence must be an object');

  const errors = [];
  const evidence = {};

  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index];
    if (!validateFragment(fragment, expected, index, errors)) continue;
    for (const fragmentError of fragment.errors) {
      addUnique(errors, `fragment[${index}]:${fragmentError}`);
    }

    for (const family of SCALAR_FAMILIES) {
      if (!Object.hasOwn(fragment.evidence, family)) continue;
      mergeRecord({
        target: evidence,
        key: family,
        record: fragment.evidence[family],
        path: `fragment[${index}].${family}`,
        expected,
        errors,
      });
    }

    if (Object.hasOwn(fragment.evidence, 'platforms')) {
      if (!isObject(fragment.evidence.platforms)) {
        addUnique(errors, `fragment[${index}].platforms:shape`);
      } else {
        evidence.platforms ??= {};
        for (const platform of PLATFORM_FAMILIES) {
          if (!Object.hasOwn(fragment.evidence.platforms, platform)) continue;
          mergeRecord({
            target: evidence.platforms,
            key: platform,
            record: fragment.evidence.platforms[platform],
            path: `fragment[${index}].platforms.${platform}`,
            expected,
            errors,
          });
        }
      }
    }

    if (Object.hasOwn(fragment.evidence, 'projects')) {
      if (!Array.isArray(fragment.evidence.projects)) {
        addUnique(errors, `fragment[${index}].projects:shape`);
      } else {
        evidence.projects ??= [];
        for (let projectIndex = 0; projectIndex < fragment.evidence.projects.length; projectIndex += 1) {
          const record = fragment.evidence.projects[projectIndex];
          const invalid = recordErrors(record, expected);
          if (invalid.length > 0) {
            for (const error of invalid) {
              addUnique(errors, `fragment[${index}].projects[${projectIndex}]:${error}`);
            }
            continue;
          }
          if (!evidence.projects.some((existing) => sameRecord(existing, record))) {
            evidence.projects.push(clone(record));
          }
        }
      }
    }
  }

  const providers = {};
  evidence.providers = {};
  for (const provider of ['codex', 'antigravity']) {
    const records = providerFieldEvidence[provider];
    const result = providerEvaluation(provider, records, expected);
    providers[provider] = result;
    if (result.verified) {
      evidence.providers[provider] = providerRecord(records, expected);
    }
  }

  const readiness = withCollectorErrors(
    evaluateCutoverReadiness({ expectedHeadSha, evidence }),
    errors,
  );

  return Object.freeze({
    evidence: Object.freeze(clone(evidence)),
    readiness,
    providers: Object.freeze(providers),
    errors: Object.freeze(errors),
  });
}

export function mergeCanonicalCutoverReadinessEvidence({
  expectedHeadSha,
  expectedRuntimeImageId,
  fragments = [],
  providerFieldEvidence = {},
} = {}) {
  identity({ expectedHeadSha, expectedRuntimeImageId });
  if (!Array.isArray(fragments)) throw new TypeError('fragments must be an array');

  const canonicalErrors = [];
  const canonicalFragments = [];
  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index];
    if (!isObject(fragment) || fragment.collectionMode !== CUTOVER_READINESS_COLLECTION_MODE
      || !isObject(fragment.probeSources)) {
      addUnique(canonicalErrors, `fragment[${index}]:collectionMode`);
      continue;
    }
    canonicalFragments.push(fragment);
  }

  const merged = mergeCutoverReadinessEvidence({
    expectedHeadSha,
    expectedRuntimeImageId,
    fragments: canonicalFragments,
    providerFieldEvidence,
  });
  if (canonicalErrors.length === 0) return merged;

  const errors = [...merged.errors];
  for (const error of canonicalErrors) addUnique(errors, error);
  return Object.freeze({
    ...merged,
    readiness: withCollectorErrors(merged.readiness, canonicalErrors),
    errors: Object.freeze(errors),
  });
}
