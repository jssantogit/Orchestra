import { createHash } from "node:crypto";
import { join } from "node:path";

import { assertParallelImplementationGroup } from "../../core/domain/parallel-implementation.mjs";
import { assessChangedPathIndependence } from "../../core/delegation/parallel-scope.mjs";
import {
  deriveMutationFacts,
  inspectDelegationArtifact,
} from "./artifact-lifecycle.mjs";
import { readDelegationArtifact } from "./artifact-store.mjs";
import {
  applyCompositionPatch,
  buildCompositionPatch,
  cleanupCompositionWorkspace,
  prepareCompositionWorkspace,
} from "./composition-workspace.mjs";
import { writeCompositeArtifact } from "./composite-artifact-store.mjs";
import { inspectMutableDelegationWorkspace } from "./mutable-workspace.mjs";
import { readParallelGroup } from "./parallel-group-store.mjs";

function failure(reason) {
  return { composed: false, reason, artifactId: null };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compositeArtifactId(groupId, memberArtifactIds) {
  const identity = `${groupId}:${[...memberArtifactIds].sort().join(":")}`;
  return `composite-${sha256(Buffer.from(identity, "utf8")).slice(0, 40)}`;
}

function sameSet(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function sameFacts(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const normalize = (facts) => [...facts].sort((a, b) => a.path.localeCompare(b.path));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function defaultServices() {
  return {
    groups: { read: readParallelGroup },
    artifacts: {
      read: readDelegationArtifact,
      inspect: inspectDelegationArtifact,
    },
    composition: {},
  };
}

function mergeServices(overrides = {}) {
  const defaults = defaultServices();
  return {
    groups: { ...defaults.groups, ...(overrides.groups ?? {}) },
    artifacts: { ...defaults.artifacts, ...(overrides.artifacts ?? {}) },
    composition: { ...defaults.composition, ...(overrides.composition ?? {}) },
  };
}

function manifestMatchesGroup(manifest, group, artifactId, expectedMemberIds) {
  if (!manifest
      || manifest.artifactId !== artifactId
      || manifest.parallelGroupId !== group.groupId
      || !expectedMemberIds.has(manifest.parallelMemberId)
      || manifest.taskId !== group.taskId
      || manifest.generation !== group.generation
      || manifest.source?.provider !== group.source.provider
      || manifest.source?.actorIdHash !== group.source.actorIdHash
      || manifest.sourceRevision !== group.sourceRevision
      || manifest.sourceFingerprint !== group.sourceFingerprint
      || manifest.canonicalGitFingerprint !== group.canonicalGitFingerprint
      || manifest.state !== "READY_FOR_REVIEW"
      || !Array.isArray(manifest.changedPaths)) return false;
  return true;
}

async function readVerifiedMembers(repoRoot, group, memberArtifactIds, services = null) {
  const artifactServices = services?.artifacts ?? {
    read: readDelegationArtifact,
    inspect: inspectDelegationArtifact,
  };
  const expectedMemberIds = new Set(group.members.map((member) => member.memberId));
  const members = [];
  for (const artifactId of memberArtifactIds) {
    let stored;
    let inspected;
    try {
      stored = artifactServices.read(repoRoot, artifactId);
      inspected = await artifactServices.inspect({ repoRoot, artifactId });
    } catch {
      return { ok: false, reason: "ARTIFACT_TAMPERED", members: [] };
    }
    const manifest = inspected?.manifest ?? stored?.manifest ?? null;
    if (!stored?.exists
        || !stored.valid
        || !Buffer.isBuffer(stored.patch)
        || inspected?.integrity?.valid !== true
        || !manifestMatchesGroup(manifest, group, artifactId, expectedMemberIds)) {
      return { ok: false, reason: "ARTIFACT_TAMPERED", members: [] };
    }
    members.push({ artifactId, stored, manifest });
  }
  if (new Set(members.map((member) => member.manifest.parallelMemberId)).size !== 2) {
    return { ok: false, reason: "ARTIFACT_TAMPERED", members: [] };
  }
  return { ok: true, reason: null, members };
}

function changedPathDecisionFor(members) {
  try {
    return assessChangedPathIndependence(
      members[0].manifest.changedPaths,
      members[1].manifest.changedPaths,
    );
  } catch {
    return { independent: false, overlaps: [] };
  }
}

export async function composeParallelMemberArtifacts({
  repoRoot,
  group,
  memberArtifactIds,
} = {}) {
  try {
    assertParallelImplementationGroup(group);
  } catch {
    const error = new Error("CAPABILITY_DENIED");
    error.code = "CAPABILITY_DENIED";
    throw error;
  }
  if (!Array.isArray(memberArtifactIds)
      || memberArtifactIds.length !== 2
      || new Set(memberArtifactIds).size !== 2) {
    const error = new Error("PARALLEL_GROUP_STATE_INVALID");
    error.code = "PARALLEL_GROUP_STATE_INVALID";
    throw error;
  }

  const verified = await readVerifiedMembers(repoRoot, group, memberArtifactIds);
  if (!verified.ok) {
    const error = new Error(verified.reason);
    error.code = verified.reason;
    throw error;
  }
  const members = verified.members;
  const independence = changedPathDecisionFor(members);
  if (!independence.independent) {
    const error = new Error("SCOPE_VIOLATION");
    error.code = "SCOPE_VIOLATION";
    throw error;
  }

  const ordered = [...members].sort((a, b) => (
    a.manifest.parallelMemberId.localeCompare(b.manifest.parallelMemberId)
  ));
  let workspace = null;
  let retained = false;
  try {
    workspace = await prepareCompositionWorkspace({ repoRoot, group });

    const memberFacts = [];
    for (const member of ordered) {
      const derived = await deriveMutationFacts({
        workspacePath: member.manifest.delegatedPath,
        baselineSha: member.manifest.syntheticBaselineSha,
        scope: member.manifest.mutationScope,
      });
      memberFacts.push(...derived.facts);
      await applyCompositionPatch(workspace, join(member.stored.path, "candidate.patch"));
    }

    const inspection = await inspectMutableDelegationWorkspace(workspace);
    if (inspection.canonicalWorkspaceChanged
        || inspection.canonicalGitChanged
        || inspection.cloneGitChanged
        || inspection.stagedByWorker) {
      const error = new Error("COMPOSITION_BOUNDARY_CHANGED");
      error.code = "COMPOSITION_BOUNDARY_CHANGED";
      throw error;
    }

    const combined = await deriveMutationFacts({
      workspacePath: workspace.path,
      baselineSha: workspace.syntheticBaselineSha,
      scope: { allowedPaths: ["**"], forbiddenPaths: [] },
    });
    const expectedPaths = [...new Set(ordered.flatMap((member) => member.manifest.changedPaths))].sort();
    if (!sameSet(combined.changedPaths, expectedPaths) || !sameFacts(combined.facts, memberFacts)) {
      const error = new Error("COMPOSITION_FACTS_MISMATCH");
      error.code = "COMPOSITION_FACTS_MISMATCH";
      throw error;
    }

    const patch = await buildCompositionPatch(workspace);
    const patchSha256 = `sha256:${sha256(patch)}`;
    const artifactId = compositeArtifactId(group.groupId, memberArtifactIds);
    const manifest = {
      schema: "orchestra.parallel-composite-artifact.v1",
      artifactId,
      groupId: group.groupId,
      taskId: group.taskId,
      generation: group.generation,
      source: { ...group.source },
      sourceRevision: group.sourceRevision,
      sourceFingerprint: group.sourceFingerprint,
      canonicalGitFingerprint: group.canonicalGitFingerprint,
      delegatedPath: workspace.path,
      syntheticBaselineSha: workspace.syntheticBaselineSha,
      memberArtifactIds: ordered.map((member) => member.artifactId),
      changedPaths: combined.changedPaths,
      patchSha256,
      mutationDigest: combined.mutationDigest,
      state: "READY_FOR_REVIEW",
      createdAt: new Date().toISOString(),
    };
    writeCompositeArtifact(repoRoot, { manifest, patch });
    retained = true;
    return {
      artifactId,
      patchSha256,
      mutationDigest: combined.mutationDigest,
      changedPaths: combined.changedPaths,
      state: "READY_FOR_REVIEW",
      reviewPath: workspace.path,
    };
  } catch (error) {
    if (error?.code === "ARTIFACT_TAMPERED"
        || error?.code === "SCOPE_VIOLATION"
        || error?.code === "CAPABILITY_DENIED"
        || error?.code === "PARALLEL_GROUP_STATE_INVALID") throw error;
    const wrapped = new Error("COMPOSITION_FAILED");
    wrapped.code = "COMPOSITION_FAILED";
    wrapped.cause = error;
    throw wrapped;
  } finally {
    if (workspace && !retained) await cleanupCompositionWorkspace(workspace);
  }
}

export async function composeParallelArtifacts({
  repoRoot,
  group,
  memberArtifactIds,
} = {}, serviceOverrides = {}) {
  const services = mergeServices(serviceOverrides);
  try {
    assertParallelImplementationGroup(group);
  } catch {
    return failure("CAPABILITY_DENIED");
  }
  if (!Array.isArray(memberArtifactIds)
      || memberArtifactIds.length !== 2
      || new Set(memberArtifactIds).size !== 2) {
    return failure("PARALLEL_GROUP_STATE_INVALID");
  }

  let groupState;
  try {
    groupState = services.groups.read(repoRoot, group.groupId);
  } catch {
    return failure("PARALLEL_GROUP_STATE_INVALID");
  }
  if (!groupState?.exists
      || !groupState.valid
      || !groupState.record
      || groupState.record.state !== "MEMBERS_READY"
      || groupState.record.group?.groupId !== group.groupId
      || !sameSet(groupState.record.memberArtifactIds, memberArtifactIds)) {
    return failure("PARALLEL_GROUP_STATE_INVALID");
  }

  const verified = await readVerifiedMembers(repoRoot, group, memberArtifactIds, services);
  if (!verified.ok) return failure(verified.reason);
  const changedPathDecision = changedPathDecisionFor(verified.members);
  if (!changedPathDecision.independent) return failure("SCOPE_VIOLATION");

  if (typeof services.composition.prepare === "function") {
    try {
      await services.composition.prepare({
        repoRoot,
        group,
        memberArtifactIds,
        manifests: verified.members.map((member) => member.manifest),
      });
    } catch {
      return failure("COMPOSITION_FAILED");
    }
    return failure("COMPOSITION_FAILED");
  }

  try {
    const descriptor = await composeParallelMemberArtifacts({ repoRoot, group, memberArtifactIds });
    return { composed: true, reason: null, ...descriptor };
  } catch (error) {
    return failure(error?.code ?? "COMPOSITION_FAILED");
  }
}
