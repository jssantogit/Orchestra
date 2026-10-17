import { createExperienceRecorders } from "../experience/recorders.mjs";
import { assessRuntimeImageCompatibility } from "./compatibility.mjs";

const SUPPORTED_PROVIDERS = Object.freeze(["codex", "antigravity"]);

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
  for (const provider of SUPPORTED_PROVIDERS) {
    if (typeof providerAdapterVersions[provider] !== "string" || providerAdapterVersions[provider].length === 0) {
      throw new TypeError(`providerAdapterVersions.${provider} is required`);
    }
  }
}

function providersFor(provider) {
  if (provider === undefined || provider === null) return SUPPORTED_PROVIDERS;
  return SUPPORTED_PROVIDERS.includes(provider) ? [provider] : null;
}

export function createRuntimeImageManager({
  state,
  imageStore,
  statusReconciler,
  engineVersion,
  providerAdapterVersions,
  experienceRecorder = null,
} = {}) {
  requireInputs({ state, imageStore, statusReconciler, engineVersion, providerAdapterVersions });
  const recorder = experienceRecorder
    ?? (state.experience ? createExperienceRecorders({ persistence: state.experience }) : null);

  async function safeRecord(method, payload) {
    try {
      if (typeof recorder?.[method] === "function") await recorder[method](payload);
    } catch {
      // Experience is non-authoritative and cannot change runtime activation outcomes.
    }
  }

  async function failAfterRecording(project, reason, fields = {}) {
    await safeRecord("recordRuntimeFailure", { project, failureClass: reason });
    return failure(reason, fields);
  }

  async function changeProjectRuntime({ projectId, targetImageId, provider, commandId = null, action }) {
    const providers = providersFor(provider);
    if (typeof projectId !== "string" || projectId.length === 0
      || typeof targetImageId !== "string" || targetImageId.length === 0
      || (commandId !== null && (typeof commandId !== "string" || commandId.length === 0))
      || !providers) {
      return failure("PROJECT_RUNTIME_CHANGE_INVALID");
    }

    const project = state.projects.inspect(projectId);
    if (!project) return failure("PROJECT_NOT_FOUND");

    const installed = await imageStore.list();
    const image = installed.find((entry) => entry.imageId === targetImageId);
    if (!image) return failAfterRecording(project, "RUNTIME_IMAGE_NOT_INSTALLED", { targetImageId });

    const integrity = await imageStore.verify(targetImageId);
    if (!integrity?.valid) {
      return failAfterRecording(project, "RUNTIME_IMAGE_INTEGRITY_FAILED", {
        targetImageId,
        verification: integrity ?? null,
      });
    }

    const compatibilityByProvider = Object.create(null);
    for (const selectedProvider of providers) {
      const compatibility = assessRuntimeImageCompatibility({
        image,
        engineVersion,
        provider: selectedProvider,
        providerAdapterVersion: providerAdapterVersions[selectedProvider],
      });
      compatibilityByProvider[selectedProvider] = compatibility;
      if (!compatibility.ok) {
        return failAfterRecording(project, "RUNTIME_IMAGE_INCOMPATIBLE", {
          targetImageId,
          provider: selectedProvider,
          compatibility,
          compatibilityByProvider,
        });
      }
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
      commandId,
    });
    if (!updated.ok) return updated;

    await safeRecord("recordRuntimeChange", { project: updated.project, action });

    const compatibility = providers.length === 1
      ? compatibilityByProvider[providers[0]]
      : compatibilityByProvider;
    return {
      ok: true,
      action,
      commandId,
      previousImageId,
      targetImageId,
      project: updated.project,
      replayed: Boolean(updated.replayed),
      compatibility,
      compatibilityByProvider,
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
