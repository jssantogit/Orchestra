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
  providerCapabilities = [],
  budget = { used: 0, limit: 1 },
} = {}) {
  return selectDelegationTarget({
    sourceProvider: SOURCE_PROVIDER,
    logicalRole,
    purpose,
    independenceRequired,
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

function runInstalledNeutralCli({ request, repoRoot, generation }) {
  const root = resolve(repoRoot);
  const cliPath = join(
    root,
    ".orchestra",
    "runtime",
    "delegation",
    "runtime",
    "delegation",
    "cli.mjs",
  );
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
