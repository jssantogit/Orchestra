import { join } from "node:path";

import {
  createHostProcessIdentityReader,
  createLocalProcessOwnerProbe,
} from "../liveness/local-process-probe.mjs";
import { createOperationLivenessService } from "../liveness/operation-liveness-service.mjs";
import { createRuntimeOwnerStore } from "../liveness/runtime-owner-store.mjs";
import { createOperationReconciler } from "../reconciliation/reconciler.mjs";

const UNRESOLVED_WORKSPACE_RECOVERY = Object.freeze({
  async inspect(workspaceRef) {
    return { workspaceRef, status: "UNKNOWN" };
  },
  async cleanup() {
    throw new Error("workspace cleanup requires a factual global workspace identity");
  },
});

export function createGlobalOperationReconciler({
  state,
  home,
  now = () => new Date().toISOString(),
  readProcessIdentity = createHostProcessIdentityReader(),
  workspaceRecovery = UNRESOLVED_WORKSPACE_RECOVERY,
} = {}) {
  if (!state) throw new TypeError("state is required");
  if (typeof home !== "string" || home.trim().length === 0) throw new TypeError("home is required");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof readProcessIdentity !== "function") throw new TypeError("readProcessIdentity must be a function");
  if (typeof workspaceRecovery?.inspect !== "function" || typeof workspaceRecovery?.cleanup !== "function") {
    throw new TypeError("workspaceRecovery.inspect and cleanup are required");
  }

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
    now,
  });

  return createOperationReconciler({
    state,
    operationLiveness,
    workspaceRecovery,
    now,
  });
}

export function createGlobalStatusReconciler(options = {}) {
  return createGlobalOperationReconciler(options);
}
