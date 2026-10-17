import { join } from "node:path";

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
  return createRecoveryAwareStatusReconciler({
    state: options.state,
    reconciler: parts.reconciler,
    workspaceRecovery: parts.workspaceRecovery,
    now: parts.now,
  });
}

export function createGlobalStatusReconciler(options = {}) {
  return createGlobalOperationReconciler(options);
}
