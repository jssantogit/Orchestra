import { createHash } from "node:crypto";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { collectCanonicalCutoverReadinessFragment } from "../v2/cutover/readiness-evidence.mjs";
import { loadRuntimeImageSource } from "../v2/runtime-images/source.mjs";
import { createRuntimeImageStore } from "../v2/runtime-images/store.mjs";
import { buildRuntimeImageSourceFromGit } from "../v2/runtime-images/source-from-git.mjs";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--repo-root", "--expected-head", "--output-dir"].includes(key)
      || typeof value !== "string" || value.length === 0 || values.has(key)) {
      throw new TypeError("Expected --repo-root, --expected-head, and --output-dir arguments");
    }
    values.set(key, value);
  }
  if (values.size !== 3) throw new TypeError("Expected --repo-root, --expected-head, and --output-dir arguments");
  return {
    repoRoot: resolve(values.get("--repo-root")),
    expectedHeadSha: values.get("--expected-head"),
    outputDir: resolve(values.get("--output-dir")),
  };
}

function requireExternalOutput(repoRoot, outputDir) {
  const pathFromRepo = relative(repoRoot, outputDir);
  if (pathFromRepo === "" || (!pathFromRepo.startsWith("..") && !isAbsolute(pathFromRepo))) {
    throw new TypeError("--output-dir must be outside the repository");
  }
}

function workflowIdentityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function validatePosixWorkflowContext({
  platform,
  nodeVersion,
  workflow,
  event,
  expectedHeadSha,
} = {}) {
  if (platform !== "linux") {
    throw workflowIdentityError("ORCHESTRA_POSIX_READINESS_PLATFORM_INVALID", "The collector requires native Linux");
  }
  if (typeof nodeVersion !== "string" || Number(nodeVersion.split(".")[0]) !== 24) {
    throw workflowIdentityError("ORCHESTRA_POSIX_READINESS_NODE_VERSION_INVALID", "The collector requires Node.js 24");
  }
  const repository = workflow?.GITHUB_REPOSITORY;
  const runId = workflow?.GITHUB_RUN_ID;
  const runAttempt = workflow?.GITHUB_RUN_ATTEMPT;
  const runHeadSha = workflow?.GITHUB_SHA;
  const pullRequestNumber = event?.pull_request?.number;
  const workflowRef = `${repository}/${'.github/workflows/v2-persistence.yml'}@refs/pull/${pullRequestNumber}/merge`;
  if (workflow?.GITHUB_ACTIONS !== "true"
    || workflow?.GITHUB_EVENT_NAME !== "pull_request"
    || typeof repository !== "string"
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || typeof runId !== "string" || !/^\d+$/.test(runId)
    || typeof runAttempt !== "string" || !/^\d+$/.test(runAttempt)
    || event?.repository?.full_name !== repository
    || typeof event?.pull_request?.head?.repo?.full_name !== "string"
    || !/^[0-9a-f]{40}$/.test(expectedHeadSha ?? "")
    || !/^[0-9a-f]{40}$/.test(runHeadSha ?? "")
    || !/^[0-9a-f]{40}$/.test(event?.pull_request?.head?.sha ?? "")
    || !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1
    || workflow?.GITHUB_JOB !== "posix-readiness"
    || workflow?.GITHUB_WORKFLOW_REF !== workflowRef) {
    throw workflowIdentityError(
      "ORCHESTRA_POSIX_READINESS_WORKFLOW_IDENTITY_INVALID",
      "The collector requires a GitHub pull-request workflow identity",
    );
  }
  if (event.pull_request.head.sha !== expectedHeadSha) {
    throw workflowIdentityError(
      "ORCHESTRA_POSIX_READINESS_WORKFLOW_HEAD_MISMATCH",
      "The workflow event head does not match the requested source revision",
    );
  }
  return Object.freeze({
    runId,
    runAttempt,
    repository,
    headRepository: event.pull_request.head.repo.full_name,
    eventName: workflow.GITHUB_EVENT_NAME,
    headSha: expectedHeadSha,
    runHeadSha,
    platform,
    nodeVersion,
    workflowPath: ".github/workflows/v2-persistence.yml",
    workflowRef,
    jobId: workflow.GITHUB_JOB,
    jobName: "POSIX Readiness (exact PR head)",
    pullRequestNumber,
  });
}

async function readWorkflowEvent(workflow) {
  if (typeof workflow.GITHUB_EVENT_PATH !== "string" || workflow.GITHUB_EVENT_PATH.length === 0) {
    throw workflowIdentityError(
      "ORCHESTRA_POSIX_READINESS_WORKFLOW_IDENTITY_INVALID",
      "The GitHub pull-request event payload is unavailable",
    );
  }
  try {
    return JSON.parse(await readFile(workflow.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    throw workflowIdentityError(
      "ORCHESTRA_POSIX_READINESS_WORKFLOW_IDENTITY_INVALID",
      "The GitHub pull-request event payload is invalid",
    );
  }
}

export async function collectPosixReadiness({ repoRoot, expectedHeadSha, outputDir } = {}) {
  const root = resolve(repoRoot ?? "");
  const output = resolve(outputDir ?? "");
  requireExternalOutput(root, output);
  const workflow = validatePosixWorkflowContext({
    platform: process.platform,
    nodeVersion: process.versions.node,
    workflow: process.env,
    event: await readWorkflowEvent(process.env),
    expectedHeadSha,
  });

  const source = buildRuntimeImageSourceFromGit({ repoRoot: root, expectedHeadSha });
  const workDir = await mkdtemp(join(tmpdir(), "orchestra-posix-readiness-"));
  try {
    const sourcePath = join(workDir, "runtime-image-source.json");
    const orchestraHome = join(workDir, "home");
    await writeFile(sourcePath, JSON.stringify(source));
    const runtimeImageSource = await loadRuntimeImageSource(sourcePath);
    const imageStore = createRuntimeImageStore({ orchestraHome });
    const image = await imageStore.install(runtimeImageSource);
    const verification = await imageStore.verify(image.imageId);
    if (!verification.valid) throw new Error("The source-derived runtime image failed integrity verification");

    const fragment = await collectCanonicalCutoverReadinessFragment({
      repoRoot: root,
      expectedHeadSha,
      expectedRuntimeImageId: image.imageId,
      probes: {
        platforms: {
          posix: {
            modulePath: "v2/cutover/readiness-probes.mjs",
            args: {},
          },
        },
      },
    });
    await mkdir(output, { recursive: true });
    const fragmentBytes = Buffer.from(JSON.stringify(fragment), "utf8");
    const evidence = {
      schema: "orchestra.posix-readiness-artifact.v1",
      workflow,
      runtimeImageId: image.imageId,
      fragmentDigest: `sha256:${createHash("sha256").update(fragmentBytes).digest("hex")}`,
      fragment,
    };
    await writeFile(join(output, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    if (typeof process.env.GITHUB_OUTPUT === "string" && process.env.GITHUB_OUTPUT.length > 0) {
      await appendFile(process.env.GITHUB_OUTPUT, `runtime-image-id=${image.imageId}\n`);
    }
    return { fragment, runtimeImageId: image.imageId };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await collectPosixReadiness(parseArgs(process.argv.slice(2)));
  } catch (error) {
    const details = { name: error?.name ?? "Error", code: error?.code ?? null };
    process.stderr.write(`${JSON.stringify(details)}\n`);
    process.exitCode = 1;
  }
}
