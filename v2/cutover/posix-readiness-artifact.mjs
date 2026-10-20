import { createHash } from 'node:crypto';

import {
  CUTOVER_READINESS_COLLECTION_MODE,
  CUTOVER_READINESS_FRAGMENT_SCHEMA,
  CUTOVER_READINESS_FRAGMENT_VERSION,
  mergeCanonicalCutoverReadinessEvidence,
} from './readiness-evidence.mjs';

const ARTIFACT_SCHEMA = 'orchestra.posix-readiness-artifact.v1';
const PROBE_MODULE_PATH = 'v2/cutover/readiness-probes.mjs';
const PROBE_EXPORT_NAME = 'posixPlatform';
const WORKFLOW_PATH = '.github/workflows/v2-persistence.yml';
const WORKFLOW_JOB_ID = 'posix-readiness';
const WORKFLOW_JOB_NAME = 'POSIX Readiness (exact PR head)';
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function artifactError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function positiveId(value) {
  return (Number.isSafeInteger(value) && value > 0)
    || (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)));
}

function expectedWorkflowRef(repository, pullRequestNumber) {
  return `${repository}/${WORKFLOW_PATH}@refs/pull/${pullRequestNumber}/merge`;
}

function expectedWorkflowApiPath() {
  return WORKFLOW_PATH;
}

function sameWorkflow(envelope, expected) {
  if (!isObject(expected)) return false;
  const workflow = envelope.workflow;
  return workflow.runId === String(expected.id)
    && workflow.runAttempt === String(expected.run_attempt)
    && workflow.repository === expected.repository
    && workflow.headRepository === expected.head_repository
    && workflow.eventName === expected.event
    && workflow.headSha === expected.pull_request_head_sha
    && workflow.runHeadSha === expected.run_head_sha
    && workflow.workflowPath === WORKFLOW_PATH
    && workflow.workflowRef === expected.workflow_ref
    && workflow.jobId === expected.job_id
    && workflow.jobName === expected.job_name
    && workflow.pullRequestNumber === expected.pull_request_number
    && typeof workflow.nodeVersion === 'string'
    && /^24\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(workflow.nodeVersion)
    && positiveId(expected.id)
    && positiveId(expected.run_attempt)
    && expected.event === 'pull_request'
    && expected.path === expectedWorkflowApiPath(expected.pull_request_number)
    && expected.head_sha === expected.pull_request_head_sha
    && /^[0-9a-f]{40}$/.test(expected.run_head_sha ?? '')
    && /^[0-9a-f]{40}$/.test(expected.head_sha ?? '')
    && /^[0-9a-f]{40}$/.test(expected.pull_request_head_sha ?? '')
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected.repository ?? '')
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected.head_repository ?? '')
    && positiveId(expected.repository_id)
    && positiveId(expected.head_repository_id)
    && expected.job_id === WORKFLOW_JOB_ID
    && expected.job_name === WORKFLOW_JOB_NAME
    && Number.isSafeInteger(expected.pull_request_number)
    && expected.pull_request_number > 0
    && expected.workflow_ref === expectedWorkflowRef(expected.repository, expected.pull_request_number);
}

function normalizeDigest(value) {
  if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) return `sha256:${value}`;
  return value;
}

function sameArtifactMetadata(actual, upload, workflow, expectedRun) {
  const expectedName = `posix-readiness-${workflow.headSha}-${workflow.runId}-${workflow.runAttempt}`;
  return isObject(actual)
    && isObject(upload)
    && positiveId(actual.id)
    && positiveId(upload.id)
    && (actual.repository_id == null || positiveId(actual.repository_id))
    && positiveId(actual.workflow_run?.id)
    && positiveId(actual.workflow_run?.repository_id)
    && positiveId(actual.workflow_run?.head_repository_id)
    && positiveId(expectedRun.repository_id)
    && positiveId(expectedRun.head_repository_id)
    && String(actual.id) === String(upload.id)
    && actual.name === expectedName
    && upload.name === expectedName
    && normalizeDigest(actual.digest) === normalizeDigest(upload.digest)
    && DIGEST_PATTERN.test(normalizeDigest(actual.digest) ?? '')
    && actual.expired === false
    && (actual.repository_id == null || String(actual.repository_id) === String(expectedRun.repository_id))
    && isObject(actual.workflow_run)
    && String(actual.workflow_run.id) === workflow.runId
    && actual.workflow_run.head_sha === expectedRun.head_sha
    && String(actual.workflow_run.repository_id) === String(expectedRun.repository_id)
    && String(actual.workflow_run.head_repository_id) === String(expectedRun.head_repository_id);
}

function validFragment(fragment, expectedHeadSha, expectedRuntimeImageId) {
  if (!hasExactKeys(fragment, [
    'schema', 'version', 'headSha', 'runtimeImageId', 'evidence', 'evidenceRefs', 'errors',
    'collectionMode', 'probeSources',
  ])
    || fragment.schema !== CUTOVER_READINESS_FRAGMENT_SCHEMA
    || fragment.version !== CUTOVER_READINESS_FRAGMENT_VERSION
    || fragment.headSha !== expectedHeadSha
    || fragment.runtimeImageId !== expectedRuntimeImageId
    || fragment.collectionMode !== CUTOVER_READINESS_COLLECTION_MODE
    || !Array.isArray(fragment.errors) || fragment.errors.length !== 0
    || !Array.isArray(fragment.evidenceRefs)
    || !hasExactKeys(fragment.evidence, ['platforms'])
    || !hasExactKeys(fragment.evidence.platforms, ['posix'])
    || !hasExactKeys(fragment.probeSources, ['platforms.posix'])) return false;

  const source = fragment.probeSources['platforms.posix'];
  const record = fragment.evidence.platforms.posix;
  if (!hasExactKeys(source, ['modulePath', 'exportName', 'sourceDigest'])
    || source.modulePath !== PROBE_MODULE_PATH
    || source.exportName !== PROBE_EXPORT_NAME
    || !DIGEST_PATTERN.test(source.sourceDigest ?? '')
    || !hasExactKeys(record, ['status', 'headSha', 'runtimeImageId', 'facts', 'evidenceRefs'])
    || record.status !== 'VERIFIED'
    || record.headSha !== expectedHeadSha
    || record.runtimeImageId !== expectedRuntimeImageId
    || !hasExactKeys(record.facts, ['nativeVerified', 'platform', 'nodeMajor'])
    || record.facts.nativeVerified !== true
    || record.facts.platform !== 'linux'
    || record.facts.nodeMajor !== 24
    || !Array.isArray(record.evidenceRefs)
    || !record.evidenceRefs.includes(source.sourceDigest)
    || !fragment.evidenceRefs.includes(source.sourceDigest)) return false;
  return record.evidenceRefs.filter((ref) => typeof ref === 'string' && ref.startsWith('evidence:probe-receipt:')).length === 1;
}

export function validateCanonicalPosixReadinessArtifact({
  artifact,
  expectedHeadSha,
  expectedRuntimeImageId,
  expectedWorkflowRun,
  expectedArtifact,
  expectedUpload,
  downloadedArchiveDigest,
} = {}) {
  if (!hasExactKeys(artifact, ['schema', 'workflow', 'runtimeImageId', 'fragmentDigest', 'fragment'])
    || artifact.schema !== ARTIFACT_SCHEMA
    || !hasExactKeys(artifact.workflow, [
      'runId', 'runAttempt', 'repository', 'headRepository', 'eventName', 'headSha', 'platform',
      'runHeadSha', 'nodeVersion', 'workflowPath', 'workflowRef', 'jobId', 'jobName', 'pullRequestNumber',
    ])) {
    throw artifactError('ORCHESTRA_POSIX_READINESS_ARTIFACT_INVALID', 'The POSIX artifact envelope has an invalid shape');
  }
  if (!sameWorkflow(artifact, expectedWorkflowRun)
    || artifact.workflow.headSha !== expectedHeadSha
    || artifact.workflow.platform !== 'linux'
    || Number(artifact.workflow.nodeVersion.split('.')[0]) !== 24) {
    throw artifactError('ORCHESTRA_POSIX_READINESS_ARTIFACT_WORKFLOW_MISMATCH', 'The POSIX artifact does not match its workflow run');
  }
  if (artifact.runtimeImageId !== expectedRuntimeImageId) {
    throw artifactError('ORCHESTRA_POSIX_READINESS_ARTIFACT_IMAGE_MISMATCH', 'The POSIX artifact runtime image does not match');
  }
  if (!sameArtifactMetadata(expectedArtifact, expectedUpload, artifact.workflow, expectedWorkflowRun)
    || normalizeDigest(downloadedArchiveDigest) !== normalizeDigest(expectedArtifact?.digest)) {
    throw artifactError('ORCHESTRA_POSIX_READINESS_ARTIFACT_METADATA_MISMATCH', 'The uploaded artifact metadata does not match the Actions API');
  }
  if (!DIGEST_PATTERN.test(artifact.fragmentDigest ?? '')
    || !validFragment(artifact.fragment, expectedHeadSha, expectedRuntimeImageId)
    || `sha256:${createHash('sha256').update(JSON.stringify(artifact.fragment), 'utf8').digest('hex')}` !== artifact.fragmentDigest) {
    throw artifactError('ORCHESTRA_POSIX_READINESS_ARTIFACT_FRAGMENT_INVALID', 'The POSIX artifact fragment or digest is invalid');
  }
  return Object.freeze({
    fragment: artifact.fragment,
    fragmentDigest: artifact.fragmentDigest,
    workflowRun: Object.freeze({ ...expectedWorkflowRun }),
    artifact: Object.freeze({
      id: String(expectedArtifact.id),
      name: expectedArtifact.name,
      digest: normalizeDigest(expectedArtifact.digest),
      workflow_run: Object.freeze({
        id: String(expectedArtifact.workflow_run.id),
        head_sha: expectedArtifact.workflow_run.head_sha,
      }),
    }),
  });
}

export async function mergeCanonicalPosixReadinessArtifact({
  repoRoot,
  expectedHeadSha,
  expectedRuntimeImageId,
  artifact,
  expectedWorkflowRun,
  expectedArtifact,
  expectedUpload,
  downloadedArchiveDigest,
} = {}) {
  const validated = validateCanonicalPosixReadinessArtifact({
    artifact,
    expectedHeadSha,
    expectedRuntimeImageId,
    expectedWorkflowRun,
    expectedArtifact,
    expectedUpload,
    downloadedArchiveDigest,
  });
  const merged = await mergeCanonicalCutoverReadinessEvidence({
    repoRoot,
    expectedHeadSha,
    expectedRuntimeImageId,
    fragments: [validated.fragment],
  });
  if (merged.errors.length > 0 || merged.evidence.platforms?.posix?.status !== 'VERIFIED') {
    throw artifactError('ORCHESTRA_POSIX_READINESS_ARTIFACT_CANONICAL_MERGE_FAILED', 'The POSIX fragment failed canonical source and receipt validation');
  }
  return Object.freeze({ validated, merged });
}
