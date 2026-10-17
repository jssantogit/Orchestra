import { join } from "node:path";

import {
  createHostProcessIdentityReader,
  createLocalProcessOwnerProbe,
} from "../liveness/local-process-probe.mjs";
import { createOperationLivenessService } from "../liveness/operation-liveness-service.mjs";
import { createRuntimeOwnerStore } from "../liveness/runtime-owner-store.mjs";
import { createOperationReconciler } from "../reconciliation/reconciler.mjs";

const INSPECTION_ONLY_WORKSPACE_RECOVERY = Object.freeze({
  async inspect() {
    throw new Error("workspace inspection is unavailable from read-only global status");
  },
  async cleanup() {
    throw new Error("workspace cleanup is unavailable from read-only global status");
  },
});

export function createGlobalStatusReconciler({
  state,
  home,
  now = () => new Date().toISOString(),
  readProcessIdentity = createHostProcessIdentityReader(),
} = {}) {
  if (!state) throw new TypeError("state is required");
  if (typeof home !== "string" || home.trim().length === 0) throw new TypeError("home is required");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof readProcessIdentity !== "function") throw new TypeError("readProcessIdentity must be a function");

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
    workspaceRecovery: INSPECTION_ONLY_WORKSPACE_RECOVERY,
    now,
  });
}
