import { createHash } from "node:crypto";

import { assertParallelImplementationGroup } from "../../core/domain/parallel-implementation.mjs";
import {
  cleanupMutableDelegationWorkspace,
  prepareMutableDelegationWorkspace,
} from "./mutable-workspace.mjs";
import {
  readDelegationGitStdout,
  runDelegationGit,
} from "./git-boundary.mjs";

const MAX_PATCH_BYTES = 64 * 1024 * 1024;
const COMPOSITION_LIMITS = Object.freeze({
  timeoutMs: 120000,
  maxOutputBytes: 65536,
  delegationDepth: 1,
});

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function compositionRequest(group) {
  const member = group.members.find((entry) => entry.targetProvider !== group.source.provider)
    ?? group.members[0];
  return {
    schema: "orchestra.delegation-request.v2",
    delegationId: `composition-${digest(group.groupId).slice(0, 40)}`,
    taskId: group.taskId,
    source: { ...group.source },
    target: { provider: member.targetProvider, logicalRole: "IMPLEMENTER" },
    purpose: "IMPLEMENTATION",
    packet: member.packet,
    authority: {
      capabilities: ["LOCAL_READ", "PROCESS_EXEC", "WORKSPACE_EDIT"],
      mutation: "WORKSPACE_ONLY",
      network: "FORBIDDEN",
      mayDelegate: false,
    },
    workspace: {
      sourceFingerprint: group.sourceFingerprint,
      sourceRevision: group.sourceRevision,
      isolation: "EPHEMERAL_CLONE",
      mutationScope: { allowedPaths: ["**"], forbiddenPaths: [] },
    },
    limits: { ...COMPOSITION_LIMITS },
  };
}

export async function prepareCompositionWorkspace({ repoRoot, group, baseDir = null } = {}) {
  assertParallelImplementationGroup(group);
  const workspace = await prepareMutableDelegationWorkspace({
    repoRoot,
    request: compositionRequest(group),
    baseDir,
  });
  if (workspace.sourceRevision !== group.sourceRevision
      || workspace.sourceFingerprint !== group.sourceFingerprint
      || workspace.canonicalGitFingerprint !== group.canonicalGitFingerprint) {
    await cleanupMutableDelegationWorkspace(workspace);
    const error = new Error("COMPOSITION_BASELINE_INVALID");
    error.code = "COMPOSITION_BASELINE_INVALID";
    throw error;
  }
  return workspace;
}

export async function applyCompositionPatch(workspace, patchPath) {
  if (!workspace?.path || typeof patchPath !== "string" || !patchPath) {
    const error = new Error("COMPOSITION_PATCH_INVALID");
    error.code = "COMPOSITION_PATCH_INVALID";
    throw error;
  }
  await runDelegationGit(workspace.path, ["apply", "--check", patchPath], { maxBuffer: MAX_PATCH_BYTES });
  await runDelegationGit(workspace.path, ["apply", patchPath], { maxBuffer: MAX_PATCH_BYTES });
}

export async function buildCompositionPatch(workspace) {
  if (!workspace?.path || !workspace.syntheticBaselineSha) {
    const error = new Error("COMPOSITION_WORKSPACE_INVALID");
    error.code = "COMPOSITION_WORKSPACE_INVALID";
    throw error;
  }
  await runDelegationGit(workspace.path, ["add", "-A", "--", "."]);
  const patchText = await readDelegationGitStdout(workspace.path, [
    "diff",
    "--cached",
    "--binary",
    "--full-index",
    workspace.syntheticBaselineSha,
    "--",
  ], { maxBuffer: MAX_PATCH_BYTES });
  return Buffer.from(patchText, "utf8");
}

export async function cleanupCompositionWorkspace(workspace) {
  return cleanupMutableDelegationWorkspace(workspace);
}
