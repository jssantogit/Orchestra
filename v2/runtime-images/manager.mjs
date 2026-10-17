import { assessRuntimeImageCompatibility } from "./compatibility.mjs";

function failure(reason, fields = {}) {
  return { ok: false, reason, ...fields };
}

function requireInputs({ state, imageStore, statusReconciler, engineVersion, providerAdapterVersions }) {
  if (typeof state?.projects?.inspect !== "function" || typeof state?.projects?.updateRuntime !== "function") {
    throw new TypeError("state.projects.inspect/updateRuntime is required");
  }
  if (typeof imageStore?.list !== "function" || typeof imageStore?.verify !== "function") {
    throw new TypeError("imageStore.list/verify is required");
  }
  if (typeof statusReconciler?.inspect !== "function") {
    throw new TypeError("statusReconciler.inspect is required");
  }
  if (typeof engineVersion !== "string" || engineVersion.length === 0) {
    throw new TypeError("engineVersion is required");
  }
  if (!providerAdapterVersions || typeof providerAdapterVersions !== "object") {
    throw new TypeError("providerAdapterVersions is required");
  }
}

export function createRuntimeImageManager({
  state,
  imageStore,
  statusReconciler,
  engineVersion,
  providerAdapterVersions,
} = {}) {
  requireInputs({ state, imageStore, statusReconciler, engineVersion, providerAdapterVersions });

  async function changeProjectRuntime({ projectId, targetImageId, provider, action }) {
    if (typeof projectId !== "string" || projectId.length === 0
      || typeof targetImageId !== "string" || targetImageId.length === 0
      || !["codex", "antigravity"].includes(provider)) {
      return failure("PROJECT_RUNTIME_CHANGE_INVALID");
    }

    const project = state.projects.inspect(projectId);
    if (!project) return failure("PROJECT_NOT_FOUND");

    const installed = await imageStore.list();
    const image = installed.find((entry) => entry.imageId === targetImageId);
    if (!image) return failure("RUNTIME_IMAGE_NOT_INSTALLED", { targetImageId });

    const integrity = await imageStore.verify(targetImageId);
    if (!integrity?.valid) {
      return failure("RUNTIME_IMAGE_INTEGRITY_FAILED", { targetImageId, verification: integrity ?? null });
    }

    const providerAdapterVersion = providerAdapterVersions[provider];
    const compatibility = assessRuntimeImageCompatibility({
      image,
      engineVersion,
      provider,
      providerAdapterVersion,
    });
    if (!compatibility.ok) {
      return failure("RUNTIME_IMAGE_INCOMPATIBLE", { targetImageId, compatibility });
    }

    const status = await statusReconciler.inspect({ projectId });
    if (!status?.ok) return failure("PROJECT_STATUS_UNAVAILABLE", { status });
    if (status.work !== null || status.operations.length > 0) {
      return failure("PROJECT_RUNTIME_CHANGE_BLOCKED", { status });
    }

    const previousImageId = project.runtime.pinnedImage;
    const updated = state.projects.updateRuntime({
      projectId,
      expectedPinnedImage: previousImageId,
      expectedInstructionEpoch: project.runtime.instructionEpoch,
      targetImage: targetImageId,
    });
    if (!updated.ok) return updated;

    return {
      ok: true,
      action,
      previousImageId,
      targetImageId,
      project: updated.project,
      replayed: Boolean(updated.replayed),
      compatibility,
    };
  }

  return Object.freeze({
    upgradeProject(command = {}) {
      return changeProjectRuntime({ ...command, action: "UPGRADE" });
    },
    rollbackProject(command = {}) {
      return changeProjectRuntime({ ...command, action: "ROLLBACK" });
    },
  });
}
