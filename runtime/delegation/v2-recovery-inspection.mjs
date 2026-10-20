import { lstat, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";

import { createRuntimeOwnerStore } from "../../v2/liveness/runtime-owner-store.mjs";
import { createHostProcessIdentityReader } from "../../v2/liveness/local-process-probe.mjs";
import {
  createManagedWorkspaceStore, resolveManagedWorkspacePaths,
} from "../../v2/workspaces/managed-workspace-store.mjs";
import { createDelegatedChildTerminalStore } from "./v2-child-terminal-store.mjs";

// This is evidence gathering, NEVER a recovery/cleanup/redispatch authority.
// In particular, even a verified direct-child close does not prove that a
// spawned grandchild exited or relinquished the managed clone.
function blocked(operationId, reason, evidence = {}) {
  return Object.freeze({
    ok: true, operationId, reason,
    evidence: Object.freeze({
      cloneStatus: evidence.cloneStatus ?? "UNVERIFIED",
      childStatus: evidence.childStatus ?? "UNAVAILABLE",
      terminalStatus: evidence.terminalStatus ?? "UNVERIFIED",
    }),
    humanGate: true, cleanupAuthorized: false, redispatchAuthorized: false,
  });
}

function directChild(parent, child) {
  const rel = relative(parent, child);
  return rel.length > 0 && rel !== "." && rel !== ".."
    && !rel.includes("/") && !rel.includes("\\") && !isAbsolute(rel);
}

async function cloneStatus({ home, operation, workspaces }) {
  let record;
  try {
    record = await workspaces.read("workspace:delegated:" + operation.operationId);
  } catch { return "INVALID"; }
  if (!record
    || record.schema !== "orchestra.managed-workspace.v2"
    || record.kind !== "TRANSIENT_GIT_CLONE"
    || record.operationId !== operation.operationId
    || record.projectId !== operation.projectId
    || record.workId !== operation.workId
    || record.generation !== operation.generation) return "INVALID";

  const roots = resolveManagedWorkspacePaths({ home });
  let canonicalInstances;
  try { canonicalInstances = await realpath(roots.instancesRoot); }
  catch { return "UNVERIFIED"; }
  // No symlink substitution and no Project root, even for missing clones.
  if (!directChild(roots.instancesRoot, record.root)
    || !directChild(canonicalInstances, record.root)) return "INVALID";
  try {
    const stat = await lstat(record.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "INVALID";
    const rootCanonical = await realpath(record.root);
    if (!directChild(canonicalInstances, rootCanonical)
      || rootCanonical !== record.root) return "INVALID";
    return "PRESENT";
  } catch (error) {
    return error?.code === "ENOENT" ? "ABSENT" : "UNVERIFIED";
  }
}

export function createDelegatedRecoveryInspection({
  home, state, readProcessIdentity = createHostProcessIdentityReader(),
  managedWorkspaceStore = null, runtimeOwnerStore = null,
  childTerminalStore = null,
} = {}) {
  if (typeof home !== "string" || !home
    || typeof state?.operations?.inspect !== "function"
    || typeof readProcessIdentity !== "function") {
    throw new TypeError("NATIVE_DELEGATED_RECOVERY_FACTS_REQUIRED");
  }

  const workspaces = managedWorkspaceStore ?? createManagedWorkspaceStore({ home });
  const owners = runtimeOwnerStore ?? createRuntimeOwnerStore({
    rootDir: join(home, "runtime-owners"),
  });
  const terminals = childTerminalStore ?? createDelegatedChildTerminalStore({
    home, runtimeOwnerStore: owners,
  });

  return Object.freeze({
    async inspect({ operationId } = {}) {
      if (typeof operationId !== "string" || !operationId) {
        return { ok: false, reason: "OPERATION_ID_INVALID" };
      }
      const operation = state.operations.inspect(operationId);
      if (!operation || operation.kind !== "DELEGATED_MUTATION") {
        return { ok: false, reason: "DELEGATED_OPERATION_NOT_FOUND" };
      }

      const clone = await cloneStatus({ home, operation, workspaces });
      if (clone === "INVALID" || clone === "UNVERIFIED") {
        return blocked(operationId, "CLONE_ASSOCIATION_UNVERIFIED", {
          cloneStatus: clone,
        });
      }

      const expectedOwnerId = "owner_delegated_child_" + operationId;
      let owner;
      try { owner = await owners.read(expectedOwnerId); }
      catch { owner = null; }
      if (!owner || owner.schema !== "orchestra.runtime-owner.v2"
        || owner.kind !== "LOCAL_PROCESS" || owner.operationId !== operationId
        || owner.runtimeOwnerId !== expectedOwnerId
        || !Number.isSafeInteger(owner.process?.pid) || owner.process.pid <= 0
        || typeof owner.process?.startIdentity !== "string"
        || !owner.process.startIdentity) {
        return blocked(operationId, "CHILD_OWNER_UNVERIFIED", {
          cloneStatus: clone,
        });
      }

      let observed;
      try { observed = await readProcessIdentity(owner.process.pid); }
      catch { observed = { status: "UNAVAILABLE" }; }
      let childStatus = "UNAVAILABLE";
      if (observed?.status === "ABSENT") childStatus = "ABSENT";
      if (observed?.status === "PRESENT") {
        childStatus = observed.processIdentity === owner.process.startIdentity
          ? "MATCH" : "MISMATCH";
      }
      let terminalStatus = "MISSING";
      try {
        const terminal = await terminals.read(operationId);
        if (terminal) {
          terminalStatus = terminal.operationId === operationId
            && terminal.runtimeOwnerId === owner.runtimeOwnerId
            && terminal.process?.pid === owner.process.pid
            && terminal.process?.startIdentity === owner.process.startIdentity
            ? "VERIFIED" : "INVALID";
        }
      } catch { terminalStatus = "INVALID"; }
      const evidence = { cloneStatus: clone, childStatus, terminalStatus };

      if (childStatus === "MATCH") return blocked(operationId, "CHILD_STILL_LIVE", evidence);
      if (childStatus === "UNAVAILABLE" || childStatus === "MISMATCH") {
        return blocked(operationId, "CHILD_LIFECYCLE_UNKNOWN", evidence);
      }
      if (terminalStatus !== "VERIFIED") {
        return blocked(operationId, "CHILD_TERMINAL_UNVERIFIED", evidence);
      }
      return blocked(operationId, "DESCENDANT_LIFECYCLE_UNPROVEN", evidence);
    },
  });
}
