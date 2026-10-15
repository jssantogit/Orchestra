import { assertParallelImplementationGroup } from "../../core/domain/parallel-implementation.mjs";
import { assessChangedPathIndependence } from "../../core/delegation/parallel-scope.mjs";
import { inspectDelegationArtifact } from "./artifact-lifecycle.mjs";
import { readDelegationArtifact } from "./artifact-store.mjs";
import { readParallelGroup } from "./parallel-group-store.mjs";

function failure(reason) {
  return { composed: false, reason, artifactId: null };
}

function sameSet(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
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

  const expectedMemberIds = new Set(group.members.map((member) => member.memberId));
  const manifests = [];
  for (const artifactId of memberArtifactIds) {
    let stored;
    let inspected;
    try {
      stored = services.artifacts.read(repoRoot, artifactId);
      inspected = await services.artifacts.inspect({ repoRoot, artifactId });
    } catch {
      return failure("ARTIFACT_TAMPERED");
    }
    const manifest = inspected?.manifest ?? stored?.manifest ?? null;
    if (!stored?.exists
        || !stored.valid
        || !Buffer.isBuffer(stored.patch)
        || inspected?.integrity?.valid !== true
        || !manifestMatchesGroup(manifest, group, artifactId, expectedMemberIds)) {
      return failure("ARTIFACT_TAMPERED");
    }
    manifests.push(manifest);
  }
  if (new Set(manifests.map((manifest) => manifest.parallelMemberId)).size !== 2) {
    return failure("ARTIFACT_TAMPERED");
  }

  let changedPathDecision;
  try {
    changedPathDecision = assessChangedPathIndependence(
      manifests[0].changedPaths,
      manifests[1].changedPaths,
    );
  } catch {
    return failure("SCOPE_VIOLATION");
  }
  if (!changedPathDecision.independent) return failure("SCOPE_VIOLATION");

  if (typeof services.composition.prepare !== "function") {
    return failure("COMPOSITION_FAILED");
  }

  try {
    await services.composition.prepare({ repoRoot, group, memberArtifactIds, manifests });
  } catch {
    return failure("COMPOSITION_FAILED");
  }
  return failure("COMPOSITION_FAILED");
}
