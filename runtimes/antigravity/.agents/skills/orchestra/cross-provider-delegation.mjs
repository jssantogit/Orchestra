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
import { selectDelegationTarget } from "./core/routing/delegation-target.mjs";

const SOURCE_PROVIDER = "antigravity";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 65_536;

export function decideAntigravityCrossProviderRoute({
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

export function buildAntigravityDelegationRequest({
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

export function buildAntigravityImplementationDelegationRequest({
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
  const scratch = mkdtempSync(join(tmpdir(), "orchestra-antigravity-delegation-"));
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

function expectedResultSchema(request) {
  return request.schema === "orchestra.delegation-request.v2"
    ? "orchestra.delegation-result.v2"
    : "orchestra.delegation-result.v1";
}

export async function executeAntigravityCrossProviderDelegation({
  request,
  repoRoot,
  generation,
  runCli = runInstalledNeutralCli,
} = {}) {
  assertDelegationRequest(request);
  if (request.source.provider !== SOURCE_PROVIDER) {
    const error = new Error("ORCHESTRA_ANTIGRAVITY_DELEGATION_SOURCE_INVALID");
    error.code = "ORCHESTRA_ANTIGRAVITY_DELEGATION_SOURCE_INVALID";
    throw error;
  }
  if (typeof repoRoot !== "string" || repoRoot.length === 0
      || !Number.isSafeInteger(generation) || generation < 0) {
    const error = new Error("ORCHESTRA_ANTIGRAVITY_DELEGATION_CONTEXT_INVALID");
    error.code = "ORCHESTRA_ANTIGRAVITY_DELEGATION_CONTEXT_INVALID";
    throw error;
  }

  const result = await runCli({ request, repoRoot, generation });
  if (!result || result.schema !== expectedResultSchema(request)) {
    const error = new Error("ORCHESTRA_ANTIGRAVITY_DELEGATION_RESULT_MISMATCH");
    error.code = "ORCHESTRA_ANTIGRAVITY_DELEGATION_RESULT_MISMATCH";
    throw error;
  }
  assertDelegationResult(result);
  if (result.delegationId !== request.delegationId
      || result.provider !== request.target.provider
      || result.logicalRole !== request.target.logicalRole
      || result.purpose !== request.purpose) {
    const error = new Error("ORCHESTRA_ANTIGRAVITY_DELEGATION_RESULT_MISMATCH");
    error.code = "ORCHESTRA_ANTIGRAVITY_DELEGATION_RESULT_MISMATCH";
    throw error;
  }

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
    const error = new Error("ORCHESTRA_ANTIGRAVITY_ARTIFACT_CONTEXT_INVALID");
    error.code = "ORCHESTRA_ANTIGRAVITY_ARTIFACT_CONTEXT_INVALID";
    throw error;
  }
}

function assertArtifactMutationContext({ repoRoot, artifactId, generation, actorIdHash }) {
  assertArtifactContext({ repoRoot, artifactId });
  if (!Number.isSafeInteger(generation) || generation < 0
      || typeof actorIdHash !== "string" || actorIdHash.length === 0) {
    const error = new Error("ORCHESTRA_ANTIGRAVITY_ARTIFACT_CONTEXT_INVALID");
    error.code = "ORCHESTRA_ANTIGRAVITY_ARTIFACT_CONTEXT_INVALID";
    throw error;
  }
}

export async function inspectAntigravityDelegationArtifact({
  repoRoot,
  artifactId,
  runArtifactCli = runInstalledArtifactCli,
} = {}) {
  assertArtifactContext({ repoRoot, artifactId });
  return runArtifactCli({ action: "inspect", repoRoot, artifactId });
}

export async function promoteAntigravityDelegationArtifact({
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

export async function discardAntigravityDelegationArtifact({
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
