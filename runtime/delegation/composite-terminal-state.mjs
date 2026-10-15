import {
  restoreCompositeArtifactReadyState,
  transitionCompositeArtifactState,
} from "./composite-artifact-store.mjs";
import { transitionParallelGroupState } from "./parallel-group-store.mjs";

function defaultServices() {
  return {
    transitionArtifact: transitionCompositeArtifactState,
    transitionGroup: transitionParallelGroupState,
    restoreArtifact: restoreCompositeArtifactReadyState,
  };
}

function transitionReason(result, fallback) {
  return typeof result?.reason === "string" && result.reason.length > 0
    ? result.reason
    : fallback;
}

export function commitCompositeTerminalState({
  repoRoot,
  artifactId,
  groupId,
  memberArtifactIds,
  nextState,
  readyManifest,
  cleanup,
} = {}, serviceOverrides = {}) {
  const services = { ...defaultServices(), ...serviceOverrides };
  if ((nextState !== "PROMOTED" && nextState !== "DISCARDED")
      || !readyManifest
      || readyManifest.state !== "READY_FOR_REVIEW") {
    return { committed: false, compensated: false, reason: "COMPOSITE_ARTIFACT_STATE_INVALID" };
  }

  let artifactTransition;
  try {
    artifactTransition = services.transitionArtifact(repoRoot, artifactId, {
      expectedState: "READY_FOR_REVIEW",
      nextState,
      cleanup,
    });
  } catch {
    return { committed: false, compensated: false, reason: "COMPOSITE_ARTIFACT_STATE_INVALID" };
  }
  if (!artifactTransition?.transitioned) {
    return {
      committed: false,
      compensated: false,
      reason: transitionReason(artifactTransition, "COMPOSITE_ARTIFACT_STATE_MISMATCH"),
    };
  }

  let groupTransition;
  try {
    groupTransition = services.transitionGroup(repoRoot, groupId, {
      expectedState: "READY_FOR_REVIEW",
      nextState,
      memberArtifactIds: [...memberArtifactIds],
      compositeArtifactId: artifactId,
    });
  } catch {
    groupTransition = { transitioned: false, reason: "PARALLEL_GROUP_STATE_INVALID" };
  }
  if (groupTransition?.transitioned) {
    return { committed: true, compensated: false, reason: null };
  }

  let restored;
  try {
    restored = services.restoreArtifact(repoRoot, artifactId, {
      expectedState: nextState,
      manifest: readyManifest,
    });
  } catch {
    restored = { restored: false };
  }
  return {
    committed: false,
    compensated: restored?.restored === true,
    reason: transitionReason(groupTransition, "PARALLEL_GROUP_STATE_INVALID"),
  };
}
