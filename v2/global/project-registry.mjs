import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir as defaultHomedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import { access, realpath } from "node:fs/promises";

import { createBlobStore } from "../persistence/blob-store.mjs";
import { createSqliteState } from "../persistence/sqlite/sqlite-state.mjs";

function projectError(code, message, fields = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, fields);
  return error;
}

function platformPath(platform) {
  return platform === "win32" ? win32 : posix;
}

export function resolveOrchestraHome({
  platform = process.platform,
  env = process.env,
  homeDir = defaultHomedir(),
} = {}) {
  const path = platformPath(platform);
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
    return path.join(local, "Orchestra");
  }
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "Orchestra");
  }
  const dataHome = env.XDG_DATA_HOME || path.join(homeDir, ".local", "share");
  return path.join(dataHome, "orchestra");
}

export function resolveGlobalRegistryPaths({ home = resolveOrchestraHome() } = {}) {
  if (typeof home !== "string" || home.trim().length === 0) throw new TypeError("home is required");
  return Object.freeze({
    home,
    statePath: join(home, "state", "orchestra.db"),
    blobRoot: join(home, "blobs"),
  });
}

export async function globalRegistryStateExists({ home = resolveOrchestraHome() } = {}) {
  const { statePath } = resolveGlobalRegistryPaths({ home });
  try {
    await access(statePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function gitTopLevel(cwd, gitBinary) {
  try {
    return execFileSync(gitBinary, ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch (error) {
    throw projectError(
      "ORCHESTRA_PROJECT_NOT_GIT",
      `Workspace is not inside a Git work tree: ${cwd}`,
      { root: cwd, causeCode: error?.code ?? null },
    );
  }
}

async function canonicalGitRoot(inputRoot, gitBinary) {
  if (typeof inputRoot !== "string" || inputRoot.trim().length === 0) {
    throw projectError("ORCHESTRA_PROJECT_ROOT_INVALID", "Project root is required", { root: inputRoot });
  }

  let resolved;
  try {
    resolved = await realpath(inputRoot);
  } catch (error) {
    throw projectError(
      "ORCHESTRA_PROJECT_ROOT_UNAVAILABLE",
      `Project root cannot be resolved: ${inputRoot}`,
      { root: inputRoot, causeCode: error?.code ?? null },
    );
  }

  let probe = resolved;
  if (basename(probe).toLowerCase() === ".git") probe = dirname(probe);

  const topLevel = gitTopLevel(probe, gitBinary);
  try {
    return await realpath(topLevel);
  } catch (error) {
    throw projectError(
      "ORCHESTRA_PROJECT_ROOT_UNAVAILABLE",
      `Git top-level cannot be resolved: ${topLevel}`,
      { root: topLevel, causeCode: error?.code ?? null },
    );
  }
}

function validateRegistrationOptions({ runtimeImage, instructionEpoch, trustMode }) {
  if (typeof runtimeImage !== "string" || runtimeImage.trim().length === 0) {
    throw projectError("ORCHESTRA_RUNTIME_IMAGE_REQUIRED", "runtimeImage is required");
  }
  if (!Number.isInteger(instructionEpoch) || instructionEpoch < 0) {
    throw projectError("ORCHESTRA_INSTRUCTION_EPOCH_INVALID", "instructionEpoch must be a non-negative integer");
  }
  if (typeof trustMode !== "string" || trustMode.trim().length === 0) {
    throw projectError("ORCHESTRA_TRUST_MODE_REQUIRED", "trustMode is required");
  }
}

export function createGlobalProjectRegistry({
  home = resolveOrchestraHome(),
  gitBinary = "git",
  sqliteTimeoutMs = 5_000,
} = {}) {
  const paths = resolveGlobalRegistryPaths({ home });
  const state = createSqliteState({ dbPath: paths.statePath, timeoutMs: sqliteTimeoutMs });
  const blobs = createBlobStore({ root: paths.blobRoot });
  let closed = false;

  function assertOpen() {
    if (closed) throw projectError("ORCHESTRA_REGISTRY_CLOSED", "Global Project Registry is closed");
  }

  return Object.freeze({
    paths,
    state,
    blobs,

    async registerWorkspace({ root, runtimeImage, instructionEpoch, trustMode } = {}) {
      assertOpen();
      const canonicalRoot = await canonicalGitRoot(root, gitBinary);

      const existing = state.projects.resolve(canonicalRoot);
      if (existing) return { ok: true, project: existing, replayed: true };

      validateRegistrationOptions({ runtimeImage, instructionEpoch, trustMode });
      const project = {
        schema: "orchestra.project.v2",
        projectId: `prj_${randomUUID()}`,
        lineageId: `lineage_${randomUUID()}`,
        workspace: {
          canonicalRoot,
          vcs: "git",
        },
        runtime: {
          pinnedImage: runtimeImage,
          instructionEpoch,
        },
        trust: {
          mode: trustMode,
        },
      };

      const result = state.projects.register(project);
      if (result.ok) return result;

      if (result.reason === "WORKSPACE_ALREADY_REGISTERED") {
        const winner = state.projects.resolve(canonicalRoot);
        if (winner) return { ok: true, project: winner, replayed: true };
      }
      return result;
    },

    async resolveWorkspace(root) {
      assertOpen();
      const canonicalRoot = await canonicalGitRoot(root, gitBinary);
      return state.projects.resolve(canonicalRoot);
    },

    inspect(projectId) {
      assertOpen();
      return state.projects.inspect(projectId);
    },

    async rebindWorkspace({ projectId, newRoot } = {}) {
      assertOpen();
      const current = state.projects.inspect(projectId);
      if (!current) return { ok: false, reason: "PROJECT_NOT_FOUND" };
      const canonicalRoot = await canonicalGitRoot(newRoot, gitBinary);
      return state.projects.rebind({
        projectId,
        expectedRoot: current.workspace.canonicalRoot,
        newRoot: canonicalRoot,
      });
    },

    close() {
      if (closed) return;
      state.close();
      closed = true;
    },
  });
}
