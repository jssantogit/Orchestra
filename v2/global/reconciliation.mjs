import { join } from "node:path";

import { createExperienceRecorders } from "../experience/recorders.mjs";
import {
  createHostProcessIdentityReader,
  createLocalProcessOwnerProbe,
} from "../liveness/local-process-probe.mjs";
import { createOperationLivenessService } from "../liveness/operation-liveness-service.mjs";
import { createProviderEventProbe } from "../liveness/provider-event-liveness.mjs";
import { createRuntimeOwnerStore } from "../liveness/runtime-owner-store.mjs";
import { createOperationReconciler } from "../reconciliation/reconciler.mjs";
import { createRecoveryAwareStatusReconciler } from "../reconciliation/recovery-aware-status.mjs";
import { createManagedWorkspaceRecovery } from "../workspaces/managed-workspace-recovery.mjs";

function resolveWorkspaceRecovery({ home, state, workspaceRecovery }) {
  const resolved = workspaceRecovery ?? createManagedWorkspaceRecovery({ home, state });
  if (typeof resolved?.inspect !== "function" || typeof resolved?.cleanup !== "function") {
    throw new TypeError("workspaceRecovery.inspect and cleanup are required");
  }
  return resolved;
}

function createGlobalReconciliationParts({
  state,
  home,
  now = () => new Date().toISOString(),
  readProcessIdentity = createHostProcessIdentityReader(),
  workspaceRecovery = null,
} = {}) {
  if (!state) throw new TypeError("state is required");
  if (typeof home !== "string" || home.trim().length === 0) throw new TypeError("home is required");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof readProcessIdentity !== "function") throw new TypeError("readProcessIdentity must be a function");

  const resolvedWorkspaceRecovery = resolveWorkspaceRecovery({ home, state, workspaceRecovery });
  const runtimeOwnerStore = createRuntimeOwnerStore({
    rootDir: join(home, "runtime-owners"),
  });
  const ownerProbe = createLocalProcessOwnerProbe({
    readProcessIdentity,
    now,
  });
  const operationLiveness = createOperationLivenessService({
    runtimeOwnerStore,
    ownerProbe,
    providerEventProbe: createProviderEventProbe({ now }),
    now,
  });
  const reconciler = createOperationReconciler({
    state,
    operationLiveness,
    workspaceRecovery: resolvedWorkspaceRecovery,
    now,
  });

  return {
    reconciler,
    workspaceRecovery: resolvedWorkspaceRecovery,
    now,
  };
}

export function createGlobalOperationReconciler(options = {}) {
  const parts = createGlobalReconciliationParts(options);
  const base = createRecoveryAwareStatusReconciler({
    state: options.state,
    reconciler: parts.reconciler,
    workspaceRecovery: parts.workspaceRecovery,
    now: parts.now,
  });
  const recorder = options.experienceRecorder
    ?? (options.state?.experience ? createExperienceRecorders({ persistence: options.state.experience }) : null);

  async function safeRecordRecovery(result, { failureClass, recoveryClass }) {
    if (!result?.ok || !result.operation || typeof recorder?.recordRecovery !== "function") return;
    const project = options.state.projects.inspect(result.operation.projectId);
    if (!project) return;
    try {
      await recorder.recordRecovery({
        project,
        operation: result.operation,
        failureClass,
        recoveryClass,
        cleanupStatus: result.cleanup?.status ?? "NOT_REQUIRED",
      });
    } catch {
      // Experience is non-authoritative and cannot change recovery outcomes.
    }
  }

  return Object.freeze({
    ...base,
    async recover(...args) {
      const result = await base.recover(...args);
      if (result?.ok && result.recovered) {
        await safeRecordRecovery(result, {
          failureClass: "OWNER_TERMINATED",
          recoveryClass: "RECONCILED",
        });
      }
      return result;
    },
    async resolveDirty(...args) {
      const result = await base.resolveDirty(...args);
      if (result?.ok && result.resolved) {
        await safeRecordRecovery(result, {
          failureClass: "STALE_DIRTY",
          recoveryClass: result.action === "DISCARD" ? "DISCARDED" : "PRESERVED",
        });
      }
      return result;
    },
  });
}

export function createGlobalStatusReconciler(options = {}) {
  return createGlobalOperationReconciler(options);
}
