import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  assertDelegationRequest,
  assertDelegationResult,
} from "./core/domain/delegation.mjs";
import { assertImplementationPacket } from "./core/domain/implementation-packet.mjs";
import { assertParallelImplementationGroup } from "./core/domain/parallel-implementation.mjs";
import { selectDelegationTarget } from "./core/routing/delegation-target.mjs";

const SOURCE_PROVIDER = "codex";
const DEFAULT_TIMEOUT_MS = 120_000;
const PARALLEL_EXECUTE_TIMEOUT_MS = DEFAULT_TIMEOUT_MS * 5;
const DEFAULT_MAX_OUTPUT_BYTES = 65_536;

export function resolveParallelCliTimeoutMs(action) {
  return action === "execute" ? PARALLEL_EXECUTE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

export function decideCodexCrossProviderRoute({
  logicalRole,
  purpose,
  independenceRequired = false,
  explicitCrossProvider = false,
  providerCapabilities = [],
  budget = { used: 0, limit: 1 },
} = {}) {
  return selectDelegationTarget({
    sourceProvider: SOURCE_PROVIDER,
    logicalRole,
    purpose,
    independenceRequired,
    explicitCrossProvider,
    providerCapabilities,
    budget,
  });
}

export function buildCodexDelegationRequest({
  delegationId,
  actorIdHash,
  targetProvider,
  logicalRole,
  purpose,
  packet,
  sourceFingerprint,
  sourceRevision,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  assertImplementationPacket(packet);
  const request = {
    schema: "orchestra.delegation-request.v1",
    delegationId,
    taskId: packet.taskId,
    source: {
      provider: SOURCE_PROVIDER,
      actorIdHash,
    },
    target: {
      provider: targetProvider,
      logicalRole,
    },
    purpose,
    packet,
    authority: {
      capabilities: ["LOCAL_READ", "PROCESS_EXEC"],
      mutation: "FORBIDDEN",
      network: "FORBIDDEN",
      mayDelegate: false,
    },
    workspace: {
      sourceFingerprint,
      sourceRevision,
      isolation: "EPHEMERAL_WORKTREE",
    },
    limits: {
      timeoutMs,
      maxOutputBytes,
      delegationDepth: 1,
    },
  };
  assertDelegationRequest(request);
  return request;
}

export function buildCodexImplementationDelegationRequest({
  delegationId,
  actorIdHash,
  targetProvider,
  packet,
  sourceFingerprint,
  sourceRevision,
  mutationScope,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  assertImplementationPacket(packet);
  const request = {
    schema: "orchestra.delegation-request.v2",
    delegationId,
    taskId: packet.taskId,
    source: {
      provider: SOURCE_PROVIDER,
      actorIdHash,
    },
    target: {
      provider: targetProvider,
      logicalRole: "IMPLEMENTER",
    },
    purpose: "IMPLEMENTATION",
    packet,
    authority: {
      capabilities: ["LOCAL_READ", "PROCESS_EXEC", "WORKSPACE_EDIT"],
      mutation: "WORKSPACE_ONLY",
      network: "FORBIDDEN",
      mayDelegate: false,
    },
    workspace: {
      sourceFingerprint,
      sourceRevision,
      isolation: "EPHEMERAL_CLONE",
      mutationScope,
    },
    limits: {
      timeoutMs,
      maxOutputBytes,
      delegationDepth: 1,
    },
  };
  assertDelegationRequest(request);
  return request;
}

function parallelGroupInvalid() {
  const error = new Error("ORCHESTRA_CODEX_PARALLEL_GROUP_INVALID");
  error.code = "ORCHESTRA_CODEX_PARALLEL_GROUP_INVALID";
  throw error;
}

export function buildCodexParallelImplementationGroup({
  groupId,
  actorIdHash,
  generation,
  sourceRevision,
  sourceFingerprint,
  canonicalGitFingerprint,
  members,
} = {}) {
  try {
    if (!Array.isArray(members) || members.length !== 2) parallelGroupInvalid();
    for (const member of members) assertImplementationPacket(member?.packet);
    const targets = members.map((member) => member?.targetProvider);
    if (targets.filter((provider) => provider === SOURCE_PROVIDER).length !== 1
        || new Set(targets).size !== 2) parallelGroupInvalid();

    const group = {
      schema: "orchestra.parallel-implementation-group.v1",
      groupId,
      taskId: members[0].packet.taskId,
      generation,
      source: {
        provider: SOURCE_PROVIDER,
        actorIdHash,
      },
      sourceRevision,
      sourceFingerprint,
      canonicalGitFingerprint,
      members,
    };
    assertParallelImplementationGroup(group);
    return group;
  } catch (error) {
    if (error?.code === "ORCHESTRA_CODEX_PARALLEL_GROUP_INVALID") throw error;
    parallelGroupInvalid();
  }
}

function neutralRuntimePath(repoRoot, entrypoint) {
  return join(
    resolve(repoRoot),
    ".orchestra",
    "runtime",
    "delegation",
    "runtime",
    "delegation",
    entrypoint,
  );
}

function runInstalledNeutralCli({ request, repoRoot, generation }) {
  const root = resolve(repoRoot);
  const cliPath = neutralRuntimePath(root, "cli.mjs");
  const scratch = mkdtempSync(join(tmpdir(), "orchestra-codex-delegation-"));
  const requestPath = join(scratch, "request.json");
  try {
    writeFileSync(requestPath, `${JSON.stringify(request)}\n`, "utf8");
    const stdout = execFileSync(process.execPath, [
      cliPath,
      "--request", requestPath,
      "--repo-root", root,
      "--generation", String(generation),
    ], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: request.limits.timeoutMs + 5_000,
      maxBuffer: Math.max(65_536, request.limits.maxOutputBytes * 2),
      env: process.env,
    });
    return JSON.parse(stdout.trim());
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function runInstalledArtifactCli({
  action,
  repoRoot,
  artifactId,
  generation,
  sourceProvider,
  actorIdHash,
}) {
  const root = resolve(repoRoot);
  const cliPath = neutralRuntimePath(root, "artifact-cli.mjs");
  const args = [
    cliPath,
    action,
    "--artifact", artifactId,
    "--repo-root", root,
  ];
  if (action !== "inspect") {
    args.push(
      "--generation", String(generation),
      "--source-provider", sourceProvider,
      "--actor-id-hash", actorIdHash,
    );
  }
  const stdout = execFileSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,
    env: process.env,
  });
  return JSON.parse(stdout.trim());
}

function runInstalledParallelCli({
  action,
  group,
  repoRoot,
  artifactId,
  generation,
  sourceProvider,
  actorIdHash,
}) {
  const root = resolve(repoRoot);
  const cliPath = neutralRuntimePath(root, "parallel-cli.mjs");
  let scratch = null;
  try {
    const args = [cliPath, action];
    if (action === "execute") {
      scratch = mkdtempSync(join(tmpdir(), "orchestra-codex-parallel-"));
      const groupPath = join(scratch, "group.json");
      writeFileSync(groupPath, `${JSON.stringify(group)}\n`, "utf8");
      args.push(
        "--group-file", groupPath,
        "--repo-root", root,
        "--source-provider", sourceProvider,
        "--actor-id-hash", actorIdHash,
      );
    } else {
      args.push("--artifact", artifactId, "--repo-root", root);
      if (action !== "inspect") {
        args.push(
          "--generation", String(generation),
          "--source-provider", sourceProvider,
          "--actor-id-hash", actorIdHash,
        );
      }
    }
    const stdout = execFileSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: resolveParallelCliTimeoutMs(action),
      maxBuffer: DEFAULT_MAX_OUTPUT_BYTES * 4,
      env: process.env,
    });
    return JSON.parse(stdout.trim());
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

function expectedResultSchema(request) {
  return request.schema === "orchestra.delegation-request.v2"
    ? "orchestra.delegation-result.v2"
    : "orchestra.delegation-result.v1";
}

export async function executeCodexCrossProviderDelegation({
  request,
  repoRoot,
  generation,
  runCli = runInstalledNeutralCli,
} = {}) {
  assertDelegationRequest(request);
  if (request.source.provider !== SOURCE_PROVIDER) {
    const error = new Error("ORCHESTRA_CODEX_DELEGATION_SOURCE_INVALID");
    error.code = "ORCHESTRA_CODEX_DELEGATION_SOURCE_INVALID";
    throw error;
  }
  if (typeof repoRoot !== "string" || repoRoot.length === 0
      || !Number.isSafeInteger(generation) || generation < 0) {
    const error = new Error("ORCHESTRA_CODEX_DELEGATION_CONTEXT_INVALID");
    error.code = "ORCHESTRA_CODEX_DELEGATION_CONTEXT_INVALID";
    throw error;
  }

  const result = await runCli({ request, repoRoot, generation });
  if (!result || result.schema !== expectedResultSchema(request)) {
    const error = new Error("ORCHESTRA_CODEX_DELEGATION_RESULT_MISMATCH");
    error.code = "ORCHESTRA_CODEX_DELEGATION_RESULT_MISMATCH";
    throw error;
  }
  assertDelegationResult(result);
  if (result.delegationId !== request.delegationId
      || result.provider !== request.target.provider
      || result.logicalRole !== request.target.logicalRole
      || result.purpose !== request.purpose) {
    const error = new Error("ORCHESTRA_CODEX_DELEGATION_RESULT_MISMATCH");
    error.code = "ORCHESTRA_CODEX_DELEGATION_RESULT_MISMATCH";
    throw error;
  }

  return {
    controlReturned: true,
    accepted: false,
    claimOnly: true,
    result,
  };
}

export async function executeCodexParallelImplementation({
  group,
  repoRoot,
  runParallelCli = runInstalledParallelCli,
} = {}) {
  assertParallelImplementationGroup(group);
  if (group.source.provider !== SOURCE_PROVIDER
      || typeof repoRoot !== "string" || repoRoot.length === 0) parallelGroupInvalid();
  const result = await runParallelCli({
    action: "execute",
    group,
    repoRoot,
    sourceProvider: SOURCE_PROVIDER,
    actorIdHash: group.source.actorIdHash,
  });
  return {
    controlReturned: true,
    accepted: false,
    claimOnly: true,
    result,
  };
}

function assertArtifactContext({ repoRoot, artifactId }) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0
      || typeof artifactId !== "string" || artifactId.length === 0) {
    const error = new Error("ORCHESTRA_CODEX_ARTIFACT_CONTEXT_INVALID");
    error.code = "ORCHESTRA_CODEX_ARTIFACT_CONTEXT_INVALID";
    throw error;
  }
}

function assertArtifactMutationContext({ repoRoot, artifactId, generation, actorIdHash }) {
  assertArtifactContext({ repoRoot, artifactId });
  if (!Number.isSafeInteger(generation) || generation < 0
      || typeof actorIdHash !== "string" || actorIdHash.length === 0) {
    const error = new Error("ORCHESTRA_CODEX_ARTIFACT_CONTEXT_INVALID");
    error.code = "ORCHESTRA_CODEX_ARTIFACT_CONTEXT_INVALID";
    throw error;
  }
}

export async function inspectCodexDelegationArtifact({
  repoRoot,
  artifactId,
  runArtifactCli = runInstalledArtifactCli,
} = {}) {
  assertArtifactContext({ repoRoot, artifactId });
  return runArtifactCli({ action: "inspect", repoRoot, artifactId });
}

export async function promoteCodexDelegationArtifact({
  repoRoot,
  artifactId,
  generation,
  actorIdHash,
  runArtifactCli = runInstalledArtifactCli,
} = {}) {
  assertArtifactMutationContext({ repoRoot, artifactId, generation, actorIdHash });
  return runArtifactCli({
    action: "promote",
    repoRoot,
    artifactId,
    generation,
    sourceProvider: SOURCE_PROVIDER,
    actorIdHash,
  });
}

export async function discardCodexDelegationArtifact({
  repoRoot,
  artifactId,
  generation,
  actorIdHash,
  runArtifactCli = runInstalledArtifactCli,
} = {}) {
  assertArtifactMutationContext({ repoRoot, artifactId, generation, actorIdHash });
  return runArtifactCli({
    action: "discard",
    repoRoot,
    artifactId,
    generation,
    sourceProvider: SOURCE_PROVIDER,
    actorIdHash,
  });
}

export async function inspectCodexCompositeArtifact({
  repoRoot,
  artifactId,
  runParallelCli = runInstalledParallelCli,
} = {}) {
  assertArtifactContext({ repoRoot, artifactId });
  return runParallelCli({ action: "inspect", repoRoot, artifactId });
}

export async function promoteCodexCompositeArtifact({
  repoRoot,
  artifactId,
  generation,
  actorIdHash,
  runParallelCli = runInstalledParallelCli,
} = {}) {
  assertArtifactMutationContext({ repoRoot, artifactId, generation, actorIdHash });
  return runParallelCli({
    action: "promote",
    repoRoot,
    artifactId,
    generation,
    sourceProvider: SOURCE_PROVIDER,
    actorIdHash,
  });
}

export async function discardCodexCompositeArtifact({
  repoRoot,
  artifactId,
  generation,
  actorIdHash,
  runParallelCli = runInstalledParallelCli,
} = {}) {
  assertArtifactMutationContext({ repoRoot, artifactId, generation, actorIdHash });
  return runParallelCli({
    action: "discard",
    repoRoot,
    artifactId,
    generation,
    sourceProvider: SOURCE_PROVIDER,
    actorIdHash,
  });
}
