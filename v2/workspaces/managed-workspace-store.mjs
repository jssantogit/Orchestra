import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const WORKSPACE_SCHEMA = "orchestra.managed-workspace.v2";
const RECORD_SCHEMA = "orchestra.managed-workspace-record.v1";
const WORKSPACE_KIND = "TRANSIENT_GIT_CLONE";
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const WORKSPACE_KEYS = new Set([
  "schema",
  "workspaceRef",
  "operationId",
  "projectId",
  "workId",
  "generation",
  "kind",
  "root",
  "registeredAt",
]);

function success(payload = {}) {
  return { ok: true, ...payload };
}

function failure(reason, payload = {}) {
  return { ok: false, reason, ...payload };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalValue(value[key]);
  return output;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value) {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

export function validateManagedWorkspaceV2(value) {
  if (!isRecord(value) || value.schema !== WORKSPACE_SCHEMA) return failure("MANAGED_WORKSPACE_INVALID");
  if (Object.keys(value).some((key) => !WORKSPACE_KEYS.has(key))) return failure("MANAGED_WORKSPACE_INVALID");
  for (const key of ["workspaceRef", "operationId", "projectId", "workId", "root"]) {
    if (!isNonEmptyString(value[key])) return failure("MANAGED_WORKSPACE_INVALID");
  }
  if (!Number.isInteger(value.generation) || value.generation < 0) return failure("MANAGED_WORKSPACE_INVALID");
  if (value.kind !== WORKSPACE_KIND) return failure("MANAGED_WORKSPACE_INVALID");
  if (!isTimestamp(value.registeredAt)) return failure("MANAGED_WORKSPACE_INVALID");
  if (!isAbsolute(value.root)) return failure("MANAGED_WORKSPACE_INVALID");
  return success();
}

export function resolveManagedWorkspacePaths({ home } = {}) {
  if (!isNonEmptyString(home)) throw new TypeError("home is required");
  const root = resolve(home, "workspaces");
  return Object.freeze({
    root,
    instancesRoot: join(root, "instances"),
    recordsRoot: join(root, "records"),
  });
}

function pathInside(parent, child) {
  const rel = relative(parent, child);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

function recordPath(recordsRoot, workspaceRef) {
  const key = createHash("sha256").update(workspaceRef, "utf8").digest("hex");
  return {
    directory: join(recordsRoot, key.slice(0, 2)),
    target: join(recordsRoot, key.slice(0, 2), `${key}.json`),
  };
}

function corruptError(workspaceRef, detail) {
  const error = new Error(`ORCHESTRA_MANAGED_WORKSPACE_CORRUPT:${workspaceRef}:${detail}`);
  error.code = "ORCHESTRA_MANAGED_WORKSPACE_CORRUPT";
  error.workspaceRef = workspaceRef;
  error.detail = detail;
  return error;
}

function makeEnvelope(workspace) {
  return {
    schema: RECORD_SCHEMA,
    digest: sha256(canonicalJson(workspace)),
    workspace: clone(workspace),
  };
}

function parseEnvelope(workspaceRef, text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw corruptError(workspaceRef, "INVALID_JSON");
  }

  if (!isRecord(envelope)
    || Object.keys(envelope).some((key) => !new Set(["schema", "digest", "workspace"]).has(key))
    || envelope.schema !== RECORD_SCHEMA
    || !DIGEST_PATTERN.test(envelope.digest ?? "")
    || !validateManagedWorkspaceV2(envelope.workspace).ok
    || envelope.workspace.workspaceRef !== workspaceRef) {
    throw corruptError(workspaceRef, "INVALID_RECORD");
  }

  if (envelope.digest !== sha256(canonicalJson(envelope.workspace))) {
    throw corruptError(workspaceRef, "DIGEST_MISMATCH");
  }
  return clone(envelope.workspace);
}

async function removeTemp(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function managedRootStatus(workspace, instancesRoot) {
  try {
    await mkdir(instancesRoot, { recursive: true });
    const instancesCanonical = await realpath(instancesRoot);
    const stat = await lstat(workspace.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return failure("MANAGED_WORKSPACE_ROOT_INVALID");
    const rootCanonical = await realpath(workspace.root);
    if (!pathInside(instancesCanonical, rootCanonical)) {
      return failure("MANAGED_WORKSPACE_ROOT_OUTSIDE_HOME");
    }
    return success({ rootCanonical });
  } catch (error) {
    if (error?.code === "ENOENT") return failure("MANAGED_WORKSPACE_ROOT_INVALID");
    throw error;
  }
}

export function createManagedWorkspaceStore({ home } = {}) {
  const paths = resolveManagedWorkspacePaths({ home });

  async function read(workspaceRef) {
    if (!isNonEmptyString(workspaceRef)) return null;
    const { target } = recordPath(paths.recordsRoot, workspaceRef);
    let text;
    try {
      text = await readFile(target, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    return parseEnvelope(workspaceRef, text);
  }

  async function existingResult(workspace) {
    const existing = await read(workspace.workspaceRef);
    if (existing === null) return null;
    if (canonicalJson(existing) === canonicalJson(workspace)) {
      return success({ workspace: existing, replayed: true });
    }
    return failure("MANAGED_WORKSPACE_ID_CONFLICT", { workspace: existing });
  }

  return Object.freeze({
    paths,

    async register(workspace) {
      if (!validateManagedWorkspaceV2(workspace).ok) return failure("MANAGED_WORKSPACE_INVALID");

      const prior = await existingResult(workspace);
      if (prior) return prior;

      const rootStatus = await managedRootStatus(workspace, paths.instancesRoot);
      if (!rootStatus.ok) return rootStatus;

      const { directory, target } = recordPath(paths.recordsRoot, workspace.workspaceRef);
      await mkdir(directory, { recursive: true });
      const envelope = makeEnvelope(workspace);
      const temp = join(directory, `.${randomUUID()}.tmp`);
      let handle = null;
      try {
        handle = await open(temp, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;

        try {
          await link(temp, target);
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          const raced = await existingResult(workspace);
          if (!raced) throw corruptError(workspace.workspaceRef, "RACE_TARGET_MISSING");
          return raced;
        }
        return success({ workspace: clone(workspace), replayed: false });
      } finally {
        if (handle) {
          try {
            await handle.close();
          } catch {
            // Preserve the primary operation result/error.
          }
        }
        await removeTemp(temp);
      }
    },

    read,
  });
}
