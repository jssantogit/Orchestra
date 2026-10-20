import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validatePosixWorkflowContext } from "./collect-posix-readiness.mjs";
import { mergeCanonicalPosixReadinessArtifact } from "../v2/cutover/posix-readiness-artifact.mjs";
import { buildRuntimeImageSourceFromGit } from "../v2/runtime-images/source-from-git.mjs";
import { loadRuntimeImageSource } from "../v2/runtime-images/source.mjs";
import { createRuntimeImageStore } from "../v2/runtime-images/store.mjs";

const WORKFLOW_NAME = "V2 Persistence";
const JOB_NAME = "POSIX Readiness (exact PR head)";
const COLLECT_STEP = "Collect canonical POSIX readiness fragment";
const UPLOAD_STEP = "Upload sanitized POSIX readiness evidence";
const WORKFLOW_PATH = ".github/workflows/v2-persistence.yml";
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw fail("ORCHESTRA_POSIX_ARTIFACT_CONTEXT_MISSING", `Missing ${name}`);
  return value;
}

function normalizeDigest(value) {
  if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) return `sha256:${value}`;
  return value;
}

export function validateApiArtifactAssociation({
  apiArtifact,
  runId,
  runAttempt,
  workflowRunHeadSha,
  expectedHeadSha,
  uploadId,
  uploadName,
  uploadDigest,
} = {}) {
  const expectedName = `posix-readiness-${expectedHeadSha}-${runId}-${runAttempt}`;
  if (!apiArtifact || String(apiArtifact.id) !== String(uploadId)
    || apiArtifact.name !== expectedName || uploadName !== expectedName
    || apiArtifact.expired !== false
    || String(apiArtifact.workflow_run?.id) !== String(runId)
    || apiArtifact.workflow_run?.head_sha !== workflowRunHeadSha
    || !/^[0-9a-f]{40}$/.test(workflowRunHeadSha ?? "")
    || !/^[0-9a-f]{40}$/.test(expectedHeadSha ?? "")
    || normalizeDigest(apiArtifact.digest) !== normalizeDigest(uploadDigest)) {
    throw fail("ORCHESTRA_POSIX_ARTIFACT_API_METADATA_MISMATCH", "The artifact metadata does not match the workflow run and PR head");
  }
  return true;
}

export function validateRunAndPullRequestAssociation({ run, pullRequest, expected } = {}) {
  const matchingPullRequests = Array.isArray(run?.pull_requests) ? run.pull_requests.filter((item) =>
    item?.number === expected?.pullRequestNumber && item.head?.sha === expected?.sourceHeadSha) : [];
  if (!run || !pullRequest || !expected
    || String(run.id) !== String(expected.id)
    || String(run.run_attempt) !== String(expected.runAttempt)
    || run.event !== "pull_request"
    || run.path !== WORKFLOW_PATH
    || run.head_sha !== expected.sourceHeadSha
    || run.repository?.full_name !== expected.repository
    || run.head_repository?.full_name !== expected.headRepository
    || matchingPullRequests.length !== 1
    || pullRequest.number !== expected.pullRequestNumber
    || pullRequest.state !== "open"
    || pullRequest.head?.sha !== expected.sourceHeadSha
    || pullRequest.head?.repo?.full_name !== expected.headRepository
    || pullRequest.base?.repo?.full_name !== expected.repository
    || pullRequest.merge_commit_sha !== expected.runHeadSha
    || !/^[0-9a-f]{40}$/.test(expected.sourceHeadSha ?? "")
    || !/^[0-9a-f]{40}$/.test(expected.runHeadSha ?? "")
    || !/^[1-9]\d*$/.test(String(expected.id ?? ""))
    || !/^[1-9]\d*$/.test(String(expected.runAttempt ?? ""))) {
    throw fail("ORCHESTRA_POSIX_ARTIFACT_RUN_MISMATCH", "GitHub run and pull-request metadata are not bound to the same source and merge revision");
  }
  return true;
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    redirect: "follow",
  });
  if (!response.ok) throw fail("ORCHESTRA_POSIX_ARTIFACT_GITHUB_API_FAILED", `GitHub API returned ${response.status}`);
  return response.json();
}

async function downloadArtifact(url, token) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") throw fail("ORCHESTRA_POSIX_ARTIFACT_DOWNLOAD_FAILED", "Artifact archive URL must use HTTPS");
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    redirect: "follow",
  });
  if (new URL(response.url).protocol !== "https:") throw fail("ORCHESTRA_POSIX_ARTIFACT_DOWNLOAD_FAILED", "Artifact redirects must remain on HTTPS");
  if (!response.ok) throw fail("ORCHESTRA_POSIX_ARTIFACT_DOWNLOAD_FAILED", `Artifact download returned ${response.status}`);
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_ARCHIVE_BYTES) {
    throw fail("ORCHESTRA_POSIX_ARTIFACT_TOO_LARGE", "Artifact archive exceeds the size limit");
  }
  if (!response.body) throw fail("ORCHESTRA_POSIX_ARTIFACT_DOWNLOAD_FAILED", "Artifact download returned no body");
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_ARCHIVE_BYTES) {
      await reader.cancel();
      throw fail("ORCHESTRA_POSIX_ARTIFACT_TOO_LARGE", "Artifact archive exceeds the size limit");
    }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks, totalBytes);
  if (bytes.length === 0) {
    throw fail("ORCHESTRA_POSIX_ARTIFACT_TOO_LARGE", "Artifact archive is empty or exceeds the size limit");
  }
  return bytes;
}

function parseSingleEvidenceMember(archivePath) {
  let listing;
  try {
    listing = execFileSync("unzip", ["-Z1", archivePath], { encoding: "utf8", maxBuffer: 32 * 1024 });
  } catch {
    throw fail("ORCHESTRA_POSIX_ARTIFACT_ARCHIVE_INVALID", "Artifact archive is not a readable ZIP");
  }
  const members = listing.split(/\r?\n/).filter(Boolean);
  if (members.length !== 1 || members[0] !== "evidence.json") {
    throw fail("ORCHESTRA_POSIX_ARTIFACT_ARCHIVE_INVALID", "Artifact ZIP must contain only evidence.json");
  }
  let contents;
  try {
    contents = execFileSync("unzip", ["-p", archivePath, "evidence.json"], { maxBuffer: MAX_EVIDENCE_BYTES + 1 });
  } catch {
    throw fail("ORCHESTRA_POSIX_ARTIFACT_ARCHIVE_INVALID", "Artifact evidence member could not be read");
  }
  if (contents.length === 0 || contents.length > MAX_EVIDENCE_BYTES) {
    throw fail("ORCHESTRA_POSIX_ARTIFACT_TOO_LARGE", "Artifact evidence member is empty or exceeds the size limit");
  }
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch {
    throw fail("ORCHESTRA_POSIX_ARTIFACT_JSON_INVALID", "Artifact evidence member is not valid JSON");
  }
}

function requireSuccessfulSteps(job) {
  if (job?.name !== JOB_NAME || job?.workflow_name !== WORKFLOW_NAME || job.status !== "in_progress") {
    throw fail("ORCHESTRA_POSIX_ARTIFACT_JOB_MISMATCH", "The expected POSIX job is not the active workflow job");
  }
  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const name of [COLLECT_STEP, UPLOAD_STEP]) {
    const matches = steps.filter((step) => step.name === name);
    if (matches.length !== 1 || matches[0].status !== "completed" || matches[0].conclusion !== "success") {
      throw fail("ORCHESTRA_POSIX_ARTIFACT_JOB_MISMATCH", "The evidence collection and upload steps did not both succeed exactly once");
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForArtifact(repoApi, runId, uploadId, artifactName, token) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await githubJson(`${repoApi}/actions/runs/${runId}/artifacts?per_page=100`, token);
    const matches = (Array.isArray(response.artifacts) ? response.artifacts : [])
      .filter((artifact) => String(artifact.id) === uploadId && artifact.name === artifactName);
    if (matches.length > 1) throw fail("ORCHESTRA_POSIX_ARTIFACT_API_METADATA_MISMATCH", "The run has duplicate matching artifacts");
    if (matches.length === 1) return matches[0];
    if (attempt < 7) await delay(1000);
  }
  throw fail("ORCHESTRA_POSIX_ARTIFACT_API_METADATA_MISMATCH", "The uploaded artifact did not appear in the run artifact API");
}

async function expectedImage(repoRoot, headSha, workDir) {
  const source = buildRuntimeImageSourceFromGit({ repoRoot, expectedHeadSha: headSha });
  const sourcePath = join(workDir, "runtime-image-source.json");
  await writeFile(sourcePath, JSON.stringify(source));
  const loaded = await loadRuntimeImageSource(sourcePath);
  const store = createRuntimeImageStore({ orchestraHome: join(workDir, "home") });
  const installed = await store.install(loaded);
  const verification = await store.verify(installed.imageId);
  if (!verification.valid) throw fail("ORCHESTRA_POSIX_ARTIFACT_IMAGE_INVALID", "The exact-head runtime image failed verification");
  return installed.imageId;
}

export async function verifyPosixReadinessArtifact({ repoRoot, expectedHeadSha, outputDir } = {}) {
  if (process.platform !== "linux" || Number(process.versions.node.split(".")[0]) !== 24) {
    throw fail("ORCHESTRA_POSIX_ARTIFACT_PLATFORM_INVALID", "Artifact verification requires Linux and Node.js 24");
  }
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (typeof token !== "string" || token.length === 0) throw fail("ORCHESTRA_POSIX_ARTIFACT_TOKEN_MISSING", "A read-only GitHub token is required");
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const runId = requiredEnv("GITHUB_RUN_ID");
  const runAttempt = requiredEnv("GITHUB_RUN_ATTEMPT");
  const eventName = requiredEnv("GITHUB_EVENT_NAME");
  const workflowRef = requiredEnv("GITHUB_WORKFLOW_REF");
  const jobId = requiredEnv("GITHUB_JOB");
  const uploadId = requiredEnv("UPLOAD_ARTIFACT_ID");
  const uploadName = requiredEnv("UPLOAD_ARTIFACT_NAME");
  const uploadDigest = normalizeDigest(requiredEnv("UPLOAD_ARTIFACT_DIGEST"));
  if (eventName !== "pull_request" || jobId !== "posix-readiness" || !/^\d+$/.test(runId) || !/^\d+$/.test(runAttempt)
    || !/^\d+$/.test(uploadId) || !/^sha256:[0-9a-f]{64}$/.test(uploadDigest)) {
    throw fail("ORCHESTRA_POSIX_ARTIFACT_CONTEXT_INVALID", "The workflow or upload outputs are malformed");
  }
  const root = resolve(repoRoot);
  const output = resolve(outputDir);
  if (!outputDir || output === root || output.startsWith(`${root}/`) || output.startsWith(`${root}\\`)) {
    throw fail("ORCHESTRA_POSIX_ARTIFACT_OUTPUT_INVALID", "Validated evidence output must be outside the checkout");
  }
  const eventPayload = JSON.parse(await readFile(requiredEnv("GITHUB_EVENT_PATH"), "utf8"));
  const workflowIdentity = validatePosixWorkflowContext({
    platform: process.platform,
    nodeVersion: process.versions.node,
    workflow: process.env,
    event: eventPayload,
    expectedHeadSha,
  });
  if (workflowIdentity.workflowRef !== workflowRef || workflowIdentity.repository !== repository) {
    throw fail("ORCHESTRA_POSIX_ARTIFACT_CONTEXT_INVALID", "Workflow environment identity disagrees with the event payload");
  }

  const apiBase = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const [owner, repo] = repository.split("/");
  const repoApi = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const run = await githubJson(`${repoApi}/actions/runs/${runId}`, token);
  const pullRequest = await githubJson(`${repoApi}/pulls/${workflowIdentity.pullRequestNumber}`, token);
  validateRunAndPullRequestAssociation({
    run,
    pullRequest,
    expected: {
      id: runId,
      runAttempt,
      sourceHeadSha: expectedHeadSha,
      runHeadSha: workflowIdentity.runHeadSha,
      repository,
      headRepository: workflowIdentity.headRepository,
      pullRequestNumber: workflowIdentity.pullRequestNumber,
    },
  });
  if (run.status !== "in_progress" || run.conclusion !== null) {
    throw fail("ORCHESTRA_POSIX_ARTIFACT_RUN_MISMATCH", "GitHub run metadata does not match this exact PR-head job");
  }
  const jobsResponse = await githubJson(`${repoApi}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`, token);
  const jobs = Array.isArray(jobsResponse.jobs) ? jobsResponse.jobs : [];
  const matchingJobs = jobs.filter((job) => job.name === JOB_NAME);
  if (matchingJobs.length !== 1) throw fail("ORCHESTRA_POSIX_ARTIFACT_JOB_MISMATCH", "GitHub did not report exactly one canonical POSIX job");
  requireSuccessfulSteps(matchingJobs[0]);

  const artifactName = `posix-readiness-${expectedHeadSha}-${runId}-${runAttempt}`;
  if (uploadName !== artifactName) {
    throw fail("ORCHESTRA_POSIX_ARTIFACT_API_METADATA_MISMATCH", "The uploaded artifact is not uniquely bound to this run attempt");
  }
  const apiArtifact = await waitForArtifact(repoApi, runId, uploadId, artifactName, token);
  validateApiArtifactAssociation({
    apiArtifact,
    runId,
    runAttempt,
    workflowRunHeadSha: run.head_sha,
    expectedHeadSha,
    uploadId,
    uploadName,
    uploadDigest,
  });
  const expectedArchiveUrl = `${repoApi}/actions/artifacts/${uploadId}/zip`;
  if (apiArtifact.archive_download_url !== expectedArchiveUrl) {
    throw fail("ORCHESTRA_POSIX_ARTIFACT_API_METADATA_MISMATCH", "The artifact archive URL is not the canonical repository API endpoint");
  }

  const archive = await downloadArtifact(apiArtifact.archive_download_url, token);
  const downloadedArchiveDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  if (downloadedArchiveDigest !== normalizeDigest(apiArtifact.digest)) {
    throw fail("ORCHESTRA_POSIX_ARTIFACT_DIGEST_MISMATCH", "Downloaded ZIP bytes do not match the GitHub artifact digest");
  }
  const workDir = await mkdtemp(join(tmpdir(), "orchestra-posix-artifact-"));
  try {
    const archivePath = join(workDir, "artifact.zip");
    await writeFile(archivePath, archive);
    const envelope = parseSingleEvidenceMember(archivePath);
    const expectedRuntimeImageId = await expectedImage(root, expectedHeadSha, workDir);
    const expectedWorkflowRun = {
      id: run.id,
      run_attempt: run.run_attempt,
      head_sha: run.head_sha,
      pull_request_head_sha: pullRequest.head.sha,
      run_head_sha: workflowIdentity.runHeadSha,
      repository: run.repository.full_name,
      repository_id: run.repository.id,
      head_repository: run.head_repository.full_name,
      head_repository_id: run.head_repository.id,
      event: run.event,
      path: run.path,
      workflow_ref: workflowRef,
      job_id: workflowIdentity.jobId,
      job_name: matchingJobs[0].name,
      pull_request_number: workflowIdentity.pullRequestNumber,
    };
    const expectedUpload = { id: uploadId, name: uploadName, digest: uploadDigest };
    const { validated, merged } = await mergeCanonicalPosixReadinessArtifact({
      repoRoot: root,
      expectedHeadSha,
      expectedRuntimeImageId,
      artifact: envelope,
      expectedWorkflowRun,
      expectedArtifact: apiArtifact,
      expectedUpload,
      downloadedArchiveDigest,
    });
    const report = {
      schema: "orchestra.posix-readiness-validation.v1",
      exactHeadSha: expectedHeadSha,
      runtimeImageId: expectedRuntimeImageId,
      workflowRun: {
        id: String(run.id),
        attempt: String(run.run_attempt),
        event: run.event,
        path: run.path,
        job: matchingJobs[0].name,
        status: run.status,
      },
      artifact: {
        id: String(apiArtifact.id),
        name: apiArtifact.name,
        apiDigest: normalizeDigest(apiArtifact.digest),
        downloadedArchiveDigest,
        fragmentDigest: validated.fragmentDigest,
      },
      receipt: "Unsigned GitHub workflow/artifact metadata plus archive and canonical source validation; not a cryptographic attestation.",
      mergedPosixStatus: merged.evidence.platforms.posix.status,
    };
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "validated-evidence.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (typeof process.env.GITHUB_STEP_SUMMARY === "string") {
      await appendFile(process.env.GITHUB_STEP_SUMMARY,
        `\n### POSIX artifact validated\n- Exact head: \`${expectedHeadSha}\`\n- Runtime image: \`${expectedRuntimeImageId}\`\n- Run attempt: \`${run.id}/${run.run_attempt}\`\n- Artifact digest (API and downloaded ZIP): \`${downloadedArchiveDigest}\`\n- Canonical POSIX result: \`${merged.evidence.platforms.posix.status}\`\n`);
    }
    if (typeof process.env.GITHUB_OUTPUT === "string") {
      await appendFile(process.env.GITHUB_OUTPUT, `runtime-image-id=${expectedRuntimeImageId}\nartifact-digest=${downloadedArchiveDigest}\n`);
    }
    return report;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await verifyPosixReadinessArtifact({
      repoRoot: process.env.GITHUB_WORKSPACE,
      expectedHeadSha: process.env.EXPECTED_HEAD,
      outputDir: process.env.VALIDATED_OUTPUT_DIR,
    });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ name: error?.name ?? "Error", code: error?.code ?? null })}\n`);
    process.exitCode = 1;
  }
}
