import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { validateCanonicalPosixReadinessArtifact } from '../../v2/cutover/posix-readiness-artifact.mjs';
import {
  validateApiArtifactAssociation,
  validatePosixJobObservation,
  validateRunAndPullRequestAssociation,
} from '../../scripts/verify-posix-readiness-artifact.mjs';

const HEAD = 'a'.repeat(40);
const IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const SOURCE_DIGEST = `sha256:${'c'.repeat(64)}`;
const ARTIFACT_DIGEST = `sha256:${'d'.repeat(64)}`;

function makeInputs() {
  const fragment = {
    schema: 'orchestra.cutover-readiness-fragment.v2',
    version: 1,
    headSha: HEAD,
    runtimeImageId: IMAGE_ID,
    collectionMode: 'CANONICAL_GIT_PROBES',
    probeSources: {
      'platforms.posix': {
        modulePath: 'v2/cutover/readiness-probes.mjs',
        exportName: 'posixPlatform',
        sourceDigest: SOURCE_DIGEST,
      },
    },
    evidence: {
      platforms: {
        posix: {
          status: 'VERIFIED',
          headSha: HEAD,
          runtimeImageId: IMAGE_ID,
          facts: { nativeVerified: true, platform: 'linux', nodeMajor: 24 },
          evidenceRefs: [SOURCE_DIGEST, `evidence:probe-receipt:${'e'.repeat(64)}`],
        },
      },
    },
    evidenceRefs: [SOURCE_DIGEST, `evidence:probe-receipt:${'e'.repeat(64)}`],
    errors: [],
  };
  const run = {
    id: 123456,
    run_attempt: 2,
    head_sha: HEAD,
    pull_request_head_sha: HEAD,
    run_head_sha: 'f'.repeat(40),
    repository: 'owner/repository',
    repository_id: 111,
    head_repository: 'contributor/repository',
    head_repository_id: 222,
    event: 'pull_request',
    path: '.github/workflows/v2-persistence.yml',
    job_id: 'posix-readiness',
    job_name: 'POSIX Readiness (exact PR head)',
    workflow_ref: 'owner/repository/.github/workflows/v2-persistence.yml@refs/pull/70/merge',
    pull_request_number: 70,
  };
  const artifactName = `posix-readiness-${HEAD}-${run.id}-${run.run_attempt}`;
  const artifact = {
    id: 987654,
    name: artifactName,
    digest: ARTIFACT_DIGEST,
    expired: false,
    workflow_run: { id: run.id, head_sha: run.head_sha },
    repository_id: null,
  };
  artifact.workflow_run.repository_id = run.repository_id;
  artifact.workflow_run.head_repository_id = run.head_repository_id;
  const uploadOutput = {
    id: artifact.id,
    name: artifact.name,
    digest: ARTIFACT_DIGEST,
  };
  const envelope = {
    schema: 'orchestra.posix-readiness-artifact.v1',
    workflow: {
      runId: String(run.id),
      runAttempt: String(run.run_attempt),
      repository: run.repository,
      headRepository: run.head_repository,
      eventName: run.event,
      headSha: HEAD,
      runHeadSha: run.run_head_sha,
      platform: 'linux',
      nodeVersion: '24.15.0',
      workflowPath: '.github/workflows/v2-persistence.yml',
      workflowRef: run.workflow_ref,
      jobId: run.job_id,
      jobName: run.job_name,
      pullRequestNumber: 70,
    },
    runtimeImageId: IMAGE_ID,
    fragmentDigest: `sha256:${createHash('sha256').update(JSON.stringify(fragment)).digest('hex')}`,
    fragment,
  };
  return { envelope, run, artifact, uploadOutput };
}

function invalidCode(code) {
  return (error) => error?.code === code;
}

test('POSIX artifact validation rejects wrong exact head, image, and workflow source identity', () => {
  const input = makeInputs();
  assert.doesNotThrow(() => validateCanonicalPosixReadinessArtifact({
    artifact: input.envelope,
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: IMAGE_ID,
    expectedWorkflowRun: input.run,
    expectedArtifact: input.artifact,
    expectedUpload: input.uploadOutput,
    downloadedArchiveDigest: ARTIFACT_DIGEST,
  }));
  assert.throws(() => validateCanonicalPosixReadinessArtifact({
    artifact: input.envelope,
    expectedHeadSha: 'f'.repeat(40),
    expectedRuntimeImageId: IMAGE_ID,
    expectedWorkflowRun: input.run,
    expectedArtifact: input.artifact,
    expectedUpload: input.uploadOutput,
    downloadedArchiveDigest: ARTIFACT_DIGEST,
  }), invalidCode('ORCHESTRA_POSIX_READINESS_ARTIFACT_WORKFLOW_MISMATCH'));

  assert.throws(() => validateCanonicalPosixReadinessArtifact({
    artifact: input.envelope,
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: `sha256:${'f'.repeat(64)}`,
    expectedWorkflowRun: input.run,
    expectedArtifact: input.artifact,
    expectedUpload: input.uploadOutput,
    downloadedArchiveDigest: ARTIFACT_DIGEST,
  }), invalidCode('ORCHESTRA_POSIX_READINESS_ARTIFACT_IMAGE_MISMATCH'));

  assert.throws(() => validateCanonicalPosixReadinessArtifact({
    artifact: input.envelope,
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: IMAGE_ID,
    expectedWorkflowRun: { ...input.run, path: '.github/workflows/other.yml' },
    expectedArtifact: input.artifact,
    expectedUpload: input.uploadOutput,
    downloadedArchiveDigest: ARTIFACT_DIGEST,
  }), invalidCode('ORCHESTRA_POSIX_READINESS_ARTIFACT_WORKFLOW_MISMATCH'));
});

test('POSIX artifact validation rejects mismatched run and upload artifact metadata', () => {
  const input = makeInputs();
  for (const expected of [
    { ...input.run, id: input.run.id + 1 },
    { ...input.run, run_attempt: input.run.run_attempt + 1 },
    { ...input.run, head_sha: 'e'.repeat(40) },
    { ...input.run, run_head_sha: 'e'.repeat(40) },
    { ...input.run, pull_request_head_sha: 'e'.repeat(40) },
    { ...input.run, event: 'push' },
    { ...input.run, repository: 'other/repository' },
    { ...input.run, job_id: 'other-job' },
  ]) {
    assert.throws(() => validateCanonicalPosixReadinessArtifact({
      artifact: input.envelope,
      expectedHeadSha: HEAD,
      expectedRuntimeImageId: IMAGE_ID,
      expectedWorkflowRun: expected,
      expectedArtifact: input.artifact,
      expectedUpload: input.uploadOutput,
      downloadedArchiveDigest: ARTIFACT_DIGEST,
    }), invalidCode('ORCHESTRA_POSIX_READINESS_ARTIFACT_WORKFLOW_MISMATCH'));
  }

  for (const expectedUpload of [
    { ...input.uploadOutput, id: input.uploadOutput.id + 1 },
    { ...input.uploadOutput, name: 'other-artifact' },
    { ...input.uploadOutput, digest: `sha256:${'f'.repeat(64)}` },
  ]) {
    assert.throws(() => validateCanonicalPosixReadinessArtifact({
      artifact: input.envelope,
      expectedHeadSha: HEAD,
      expectedRuntimeImageId: IMAGE_ID,
      expectedWorkflowRun: input.run,
      expectedArtifact: input.artifact,
      expectedUpload,
      downloadedArchiveDigest: ARTIFACT_DIGEST,
    }), invalidCode('ORCHESTRA_POSIX_READINESS_ARTIFACT_METADATA_MISMATCH'));
  }

  for (const expectedArtifact of [
    { ...input.artifact, id: input.artifact.id + 1 },
    { ...input.artifact, name: 'other-artifact' },
    { ...input.artifact, digest: `sha256:${'f'.repeat(64)}` },
    { ...input.artifact, workflow_run: { ...input.artifact.workflow_run, head_sha: 'e'.repeat(40) } },
  ]) {
    assert.throws(() => validateCanonicalPosixReadinessArtifact({
      artifact: input.envelope,
      expectedHeadSha: HEAD,
      expectedRuntimeImageId: IMAGE_ID,
      expectedWorkflowRun: input.run,
      expectedArtifact,
      expectedUpload: input.uploadOutput,
      downloadedArchiveDigest: ARTIFACT_DIGEST,
    }), invalidCode('ORCHESTRA_POSIX_READINESS_ARTIFACT_METADATA_MISMATCH'));
  }
});

test('POSIX artifact validation rejects changed fragment bytes and invalid execution facts', () => {
  const input = makeInputs();
  input.envelope.fragment.evidence.platforms.posix.facts.platform = 'darwin';
  assert.throws(() => validateCanonicalPosixReadinessArtifact({
    artifact: input.envelope,
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: IMAGE_ID,
    expectedWorkflowRun: input.run,
    expectedArtifact: input.artifact,
    expectedUpload: input.uploadOutput,
    downloadedArchiveDigest: ARTIFACT_DIGEST,
  }), invalidCode('ORCHESTRA_POSIX_READINESS_ARTIFACT_FRAGMENT_INVALID'));

  const malformed = makeInputs();
  malformed.envelope.unexpected = true;
  assert.throws(() => validateCanonicalPosixReadinessArtifact({
    artifact: malformed.envelope,
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: IMAGE_ID,
    expectedWorkflowRun: malformed.run,
    expectedArtifact: malformed.artifact,
    expectedUpload: malformed.uploadOutput,
    downloadedArchiveDigest: ARTIFACT_DIGEST,
  }), invalidCode('ORCHESTRA_POSIX_READINESS_ARTIFACT_INVALID'));
});

test('POSIX artifact validation binds the downloaded ZIP digest and rejects incomplete API context', () => {
  const input = makeInputs();
  input.envelope.workflow.runHeadSha = 'e'.repeat(40);
  assert.throws(() => validateCanonicalPosixReadinessArtifact({
    artifact: input.envelope,
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: IMAGE_ID,
    expectedWorkflowRun: input.run,
    expectedArtifact: input.artifact,
    expectedUpload: input.uploadOutput,
    downloadedArchiveDigest: ARTIFACT_DIGEST,
  }), invalidCode('ORCHESTRA_POSIX_READINESS_ARTIFACT_WORKFLOW_MISMATCH'));
  input.envelope.workflow.runHeadSha = input.run.run_head_sha;

  assert.throws(() => validateCanonicalPosixReadinessArtifact({
    artifact: input.envelope,
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: IMAGE_ID,
    expectedWorkflowRun: input.run,
    expectedArtifact: input.artifact,
    expectedUpload: input.uploadOutput,
    downloadedArchiveDigest: `sha256:${'f'.repeat(64)}`,
  }), invalidCode('ORCHESTRA_POSIX_READINESS_ARTIFACT_METADATA_MISMATCH'));

  assert.throws(() => validateCanonicalPosixReadinessArtifact({
    artifact: input.envelope,
    expectedHeadSha: HEAD,
    expectedRuntimeImageId: IMAGE_ID,
    expectedWorkflowRun: undefined,
    expectedArtifact: input.artifact,
    expectedUpload: input.uploadOutput,
    downloadedArchiveDigest: ARTIFACT_DIGEST,
  }), invalidCode('ORCHESTRA_POSIX_READINESS_ARTIFACT_WORKFLOW_MISMATCH'));
});

test('POSIX consumer binds artifact to merge-run SHA and PR artifact name to source head', () => {
  const runId = '123456';
  const runAttempt = '2';
  const runHeadSha = 'f'.repeat(40);
  const workflowHeadSha = HEAD;
  const digest = `sha256:${'d'.repeat(64)}`;
  const uploadId = '987654';
  const uploadName = `posix-readiness-${HEAD}-${runId}-${runAttempt}`;
  const apiArtifact = {
    id: Number(uploadId),
    name: uploadName,
    digest,
    expired: false,
    workflow_run: { id: Number(runId), head_sha: workflowHeadSha },
  };

  assert.equal(validateApiArtifactAssociation({
    apiArtifact,
    runId,
    runAttempt,
    workflowRunHeadSha: workflowHeadSha,
    expectedHeadSha: HEAD,
    uploadId,
    uploadName,
    uploadDigest: digest,
  }), true);
  assert.throws(() => validateApiArtifactAssociation({
    apiArtifact: { ...apiArtifact, workflow_run: { ...apiArtifact.workflow_run, head_sha: runHeadSha } },
    runId,
    runAttempt,
    workflowRunHeadSha: workflowHeadSha,
    expectedHeadSha: HEAD,
    uploadId,
    uploadName,
    uploadDigest: digest,
  }), invalidCode('ORCHESTRA_POSIX_ARTIFACT_API_METADATA_MISMATCH'));
  assert.throws(() => validateApiArtifactAssociation({
    apiArtifact,
    runId,
    runAttempt,
    expectedHeadSha: runHeadSha,
    uploadId,
    uploadName,
    uploadDigest: digest,
  }), invalidCode('ORCHESTRA_POSIX_ARTIFACT_API_METADATA_MISMATCH'));
});

test('POSIX consumer binds source head and synthetic merge SHA to the real PR API response', () => {
  const run = {
    id: 123456,
    run_attempt: 2,
    event: 'pull_request',
    path: '.github/workflows/v2-persistence.yml',
    head_sha: HEAD,
    repository: { full_name: 'owner/repository' },
    head_repository: { full_name: 'contributor/repository' },
    pull_requests: [{ number: 70, head: { sha: HEAD } }],
  };
  const pullRequest = {
    number: 70,
    state: 'open',
    head: { sha: HEAD, repo: { full_name: 'contributor/repository' } },
    base: { repo: { full_name: 'owner/repository' } },
    merge_commit_sha: 'f'.repeat(40),
  };
  const expected = {
    id: '123456',
    runAttempt: '2',
    sourceHeadSha: HEAD,
    runHeadSha: 'f'.repeat(40),
    repository: 'owner/repository',
    headRepository: 'contributor/repository',
    workflowPath: '.github/workflows/v2-persistence.yml',
    pullRequestNumber: 70,
  };

  const job = {
    name: 'POSIX Readiness (exact PR head)',
    workflow_name: 'V2 Persistence',
    status: 'in_progress',
    steps: [
      { name: 'Collect canonical POSIX readiness fragment', status: 'completed', conclusion: 'success' },
      { name: 'Upload sanitized POSIX readiness evidence', status: 'completed', conclusion: 'success' },
    ],
  };

  assert.equal(validateRunAndPullRequestAssociation({
    run: { ...run, status: 'queued', conclusion: null },
    pullRequest,
    expected,
  }), true);
  assert.equal(validatePosixJobObservation(job), true);
  assert.throws(() => validatePosixJobObservation({ ...job, name: 'other-job' }),
    invalidCode('ORCHESTRA_POSIX_ARTIFACT_JOB_MISMATCH'));
  assert.throws(() => validatePosixJobObservation({ ...job, status: 'completed' }),
    invalidCode('ORCHESTRA_POSIX_ARTIFACT_JOB_MISMATCH'));
  assert.throws(() => validatePosixJobObservation({
    ...job,
    steps: [job.steps[0], { ...job.steps[1], conclusion: 'failure' }],
  }), invalidCode('ORCHESTRA_POSIX_ARTIFACT_JOB_MISMATCH'));
  assert.throws(() => validateRunAndPullRequestAssociation({
    run,
    pullRequest: { ...pullRequest, merge_commit_sha: 'e'.repeat(40) },
    expected,
  }), invalidCode('ORCHESTRA_POSIX_ARTIFACT_RUN_MISMATCH'));
  assert.throws(() => validateRunAndPullRequestAssociation({
    run: { ...run, path: `${expected.workflowPath}@refs/pull/70/merge` },
    pullRequest,
    expected,
  }), invalidCode('ORCHESTRA_POSIX_ARTIFACT_RUN_MISMATCH'));
});
