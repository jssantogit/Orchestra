import { execFile } from "node:child_process";
import { lstat, realpath, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { isAbsolute, relative, resolve } from "node:path";

import {
  createManagedWorkspaceStore,
  resolveManagedWorkspacePaths,
} from "./managed-workspace-store.mjs";

const execFileAsync = promisify(execFile);

function status(workspaceRef, value) {
  return { workspaceRef, status: value };
}

function operationMatchesRecord(operation, record) {
  return Boolean(operation)
    && operation.workspaceRef === record.workspaceRef
    && operation.operationId === record.operationId
    && operation.projectId === record.projectId
    && operation.workId === record.workId
    && operation.generation === record.generation;
}

function pathInside(parent, child) {
  const rel = relative(parent, child);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

function directChildOf(parent, child) {
  const rel = relative(parent, child);
  return rel.length > 0
    && rel !== "."
    && rel !== ".."
    && !rel.includes("/")
    && !rel.includes("\\")
    && !isAbsolute(rel);
}

function comparable(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function canonicalOrResolved(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error?.code === "ENOENT") return resolve(path);
    throw error;
  }
}

async function gitOutput(args) {
  const { stdout } = await execFileAsync("git", args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function cleanupError(code, workspaceRef) {
  const error = new Error(`${code}:${workspaceRef}`);
  error.code = code;
  error.workspaceRef = workspaceRef;
  return error;
}

export function createManagedWorkspaceRecovery({ home, state, store = null } = {}) {
  if (!state?.projects?.inspect) throw new TypeError("state.projects.inspect is required");
  const paths = resolveManagedWorkspacePaths({ home });
  const workspaceStore = store ?? createManagedWorkspaceStore({ home });
  if (typeof workspaceStore?.read !== "function") throw new TypeError("managed workspace store read is required");

  async function inspect(workspaceRef, operation) {
    if (typeof workspaceRef !== "string" || workspaceRef.length === 0) return status(workspaceRef ?? null, "UNKNOWN");

    let record;
    try {
      record = await workspaceStore.read(workspaceRef);
    } catch {
      return status(workspaceRef, "UNKNOWN");
    }
    if (!record || !operationMatchesRecord(operation, record)) return status(workspaceRef, "UNKNOWN");

    const project = state.projects.inspect(operation.projectId);
    if (!project) return status(workspaceRef, "UNKNOWN");

    let rootStat;
    try {
      rootStat = await lstat(record.root);
    } catch (error) {
      if (error?.code === "ENOENT") return status(workspaceRef, "ABSENT");
      return status(workspaceRef, "UNKNOWN");
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return status(workspaceRef, "UNKNOWN");

    try {
      const instancesCanonical = await realpath(paths.instancesRoot);
      const rootCanonical = await realpath(record.root);
      if (!pathInside(instancesCanonical, rootCanonical)) return status(workspaceRef, "UNKNOWN");
      if (!directChildOf(instancesCanonical, rootCanonical)) return status(workspaceRef, "UNKNOWN");

      const projectCanonical = await canonicalOrResolved(project.workspace.canonicalRoot);
      if (comparable(rootCanonical) === comparable(projectCanonical)) return status(workspaceRef, "UNKNOWN");

      const gitTop = await gitOutput(["-C", rootCanonical, "rev-parse", "--show-toplevel"]);
      const gitCanonical = await realpath(gitTop);
      if (comparable(gitCanonical) !== comparable(rootCanonical)) return status(workspaceRef, "UNKNOWN");

      const porcelain = await gitOutput(["-C", rootCanonical, "status", "--porcelain=v1", "--untracked-files=all"]);
      return status(workspaceRef, porcelain.length === 0 ? "CLEAN" : "DIRTY");
    } catch {
      return status(workspaceRef, "UNKNOWN");
    }
  }

  async function removeBoundWorkspace(workspaceRef, operation, expectedStatus, errorCode) {
    const inspection = await inspect(workspaceRef, operation);
    if (inspection.status === "ABSENT") return { workspaceRef, removed: true };
    if (inspection.status !== expectedStatus) throw cleanupError(errorCode, workspaceRef);

    const record = await workspaceStore.read(workspaceRef);
    if (!record || !operationMatchesRecord(operation, record)) {
      throw cleanupError("ORCHESTRA_MANAGED_WORKSPACE_UNSAFE", workspaceRef);
    }

    await rm(record.root, { recursive: true, force: true });
    return { workspaceRef, removed: true };
  }

  async function cleanup(workspaceRef, operation) {
    const inspection = await inspect(workspaceRef, operation);
    if (inspection.status === "ABSENT") return { workspaceRef, cleaned: true };
    if (inspection.status === "DIRTY") throw cleanupError("ORCHESTRA_MANAGED_WORKSPACE_DIRTY", workspaceRef);
    if (inspection.status !== "CLEAN") throw cleanupError("ORCHESTRA_MANAGED_WORKSPACE_UNSAFE", workspaceRef);

    await removeBoundWorkspace(workspaceRef, operation, "CLEAN", "ORCHESTRA_MANAGED_WORKSPACE_UNSAFE");
    return { workspaceRef, cleaned: true };
  }

  async function discard(workspaceRef, operation) {
    const inspection = await inspect(workspaceRef, operation);
    if (inspection.status === "ABSENT") return { workspaceRef, discarded: true };
    if (inspection.status !== "DIRTY") throw cleanupError("ORCHESTRA_MANAGED_WORKSPACE_DISCARD_UNSAFE", workspaceRef);

    await removeBoundWorkspace(workspaceRef, operation, "DIRTY", "ORCHESTRA_MANAGED_WORKSPACE_DISCARD_UNSAFE");
    return { workspaceRef, discarded: true };
  }

  return Object.freeze({ inspect, cleanup, discard });
}
