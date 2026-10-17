import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { inventoryLegacyProject } from "./inventory.mjs";
import { readMigrationActivationReceipt } from "./shim-activation.mjs";

const MANAGED_RUNTIME_CATEGORY = "MANAGED_RUNTIME";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function objectDigest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex")}`;
}

function bytesDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function manifestInventoryDigest(manifest) {
  return objectDigest((manifest.inventory ?? []).map((item) => ({
    path: item.path ?? null,
    digest: item.digest ?? null,
    category: item.category ?? null,
    disposition: item.disposition ?? null,
    private: item.private === true,
  })));
}

function cleanRelativePath(path) {
  if (!nonEmptyString(path) || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return segments;
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function maybeLstat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function validatePathChain(workspaceRoot, relativePath, { allowMissingFinal = false } = {}) {
  const segments = cleanRelativePath(relativePath);
  if (!segments) return { ok: false, reason: "MIGRATION_PATH_ESCAPE_BLOCKED" };
  let current = workspaceRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    if (!inside(workspaceRoot, current)) return { ok: false, reason: "MIGRATION_PATH_ESCAPE_BLOCKED" };
    const stat = await maybeLstat(current);
    if (stat === null) {
      if (allowMissingFinal && index === segments.length - 1) return { ok: true, path: current, missing: true };
      return { ok: false, reason: "MIGRATION_MANAGED_FILE_MISSING", path: relativePath };
    }
    if (stat.isSymbolicLink()) return { ok: false, reason: "MIGRATION_PATH_ESCAPE_BLOCKED", path: relativePath };
    if (index < segments.length - 1 && !stat.isDirectory()) {
      return { ok: false, reason: "MIGRATION_MANAGED_FILE_CHANGED", path: relativePath };
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      return { ok: false, reason: "MIGRATION_MANAGED_FILE_CHANGED", path: relativePath };
    }
  }
  return { ok: true, path: current, missing: false };
}

function originalManagedEntries(manifest) {
  if (!Array.isArray(manifest.inventory)) return null;
  const entries = manifest.inventory.filter((entry) => entry?.category === MANAGED_RUNTIME_CATEGORY);
  for (const entry of entries) {
    if (entry.private === true || !cleanRelativePath(entry.path) || !/^sha256:[0-9a-f]{64}$/.test(entry.digest ?? "")) {
      return null;
    }
  }
  return entries;
}

function receiptMatches({ receipt, project, manifest, inventoryDigest }) {
  return receipt.projectId === project.projectId
    && receipt.projectLineageId === project.lineageId
    && receipt.workspace === project.workspace?.canonicalRoot
    && receipt.workspace === manifest.workspace
    && receipt.runtimeImage === project.runtime?.pinnedImage
    && receipt.instructionEpoch === project.runtime?.instructionEpoch
    && receipt.inventoryDigest === inventoryDigest
    && receipt.integrationMode === "V2_GLOBAL"
    && receipt.verified === true
    && receipt.cleanupEligible === true;
}

function blocked(reason, fields = {}) {
  return { ok: false, code: "MIGRATION_CLEANUP_BLOCKED", reason, ...fields };
}

async function scanBeforeCleanup({ workspaceRoot, manifest, thinShims, resume }) {
  const scan = await inventoryLegacyProject({ workspace: workspaceRoot });
  if (!scan.ok) {
    const pathEscape = scan.issues?.find((issue) => issue.code === "MIGRATION_PATH_ESCAPE_BLOCKED");
    return blocked(pathEscape ? "MIGRATION_PATH_ESCAPE_BLOCKED" : "MIGRATION_INVENTORY_BLOCKED", {
      issues: scan.issues ?? [],
    });
  }

  const originalManaged = originalManagedEntries(manifest);
  if (originalManaged === null) return blocked("MIGRATION_MANIFEST_CORRUPT");
  const originalByPath = new Map(originalManaged.map((entry) => [entry.path, entry]));
  const shimSet = new Set(thinShims);

  for (const current of scan.entries.filter((entry) => entry.category === MANAGED_RUNTIME_CATEGORY)) {
    if (!originalByPath.has(current.path) && !shimSet.has(current.path)) {
      return blocked("MIGRATION_UNRECOGNIZED_MANAGED_FILE", { path: current.path });
    }
  }

  const removable = [];
  for (const entry of originalManaged) {
    if (shimSet.has(entry.path)) continue;
    const checked = await validatePathChain(workspaceRoot, entry.path, { allowMissingFinal: resume });
    if (!checked.ok) return blocked(checked.reason, { path: entry.path });
    if (checked.missing) {
      removable.push({ ...entry, absolutePath: checked.path, alreadyMissing: true });
      continue;
    }
    const currentDigest = bytesDigest(await readFile(checked.path));
    if (currentDigest !== entry.digest) {
      return blocked("MIGRATION_MANAGED_FILE_CHANGED", { path: entry.path });
    }
    removable.push({ ...entry, absolutePath: checked.path, alreadyMissing: false });
  }

  for (const shim of thinShims) {
    const checked = await validatePathChain(workspaceRoot, shim);
    if (!checked.ok) return blocked("MIGRATION_THIN_SHIM_INVALID", { path: shim, sourceReason: checked.reason });
  }

  return { ok: true, removable };
}

async function pruneEmptyParents(workspaceRoot, absoluteFile) {
  let current = dirname(absoluteFile);
  while (current !== workspaceRoot && inside(workspaceRoot, current)) {
    try {
      await rmdir(current);
    } catch (error) {
      if (["ENOTEMPTY", "EEXIST", "ENOENT"].includes(error?.code)) return;
      throw error;
    }
    current = dirname(current);
  }
}

async function deletePreparedFiles(workspaceRoot, removable) {
  for (const item of removable) {
    const checked = await validatePathChain(workspaceRoot, item.path, { allowMissingFinal: true });
    if (!checked.ok) return blocked(checked.reason, { path: item.path });
    if (checked.missing) continue;
    const currentDigest = bytesDigest(await readFile(checked.path));
    if (currentDigest !== item.digest) return blocked("MIGRATION_MANAGED_FILE_CHANGED", { path: item.path });
    try {
      await unlink(checked.path);
      await pruneEmptyParents(workspaceRoot, checked.path);
    } catch (error) {
      return blocked("MIGRATION_MANAGED_FILE_DELETE_FAILED", {
        path: item.path,
        sourceCode: error?.code ?? null,
      });
    }
  }
  return { ok: true };
}

async function verifyAfterCleanup({ workspaceRoot, thinShims }) {
  const shimSet = new Set(thinShims);
  for (const shim of thinShims) {
    const checked = await validatePathChain(workspaceRoot, shim);
    if (!checked.ok) return blocked("MIGRATION_THIN_SHIM_INVALID", { path: shim, sourceReason: checked.reason });
  }
  const scan = await inventoryLegacyProject({ workspace: workspaceRoot });
  if (!scan.ok) {
    const pathEscape = scan.issues?.find((issue) => issue.code === "MIGRATION_PATH_ESCAPE_BLOCKED");
    return blocked(pathEscape ? "MIGRATION_PATH_ESCAPE_BLOCKED" : "MIGRATION_INVENTORY_BLOCKED", {
      issues: scan.issues ?? [],
    });
  }
  const remaining = scan.entries
    .filter((entry) => entry.category === MANAGED_RUNTIME_CATEGORY && !shimSet.has(entry.path))
    .map((entry) => entry.path);
  if (remaining.length > 0) return blocked("MIGRATION_MANAGED_RUNTIME_REMAINS", { paths: remaining });
  return { ok: true };
}

export function createMigrationCleanup({
  registry,
  lifecycleStore,
  home,
  readActivationReceipt = readMigrationActivationReceipt,
} = {}) {
  if (!registry || typeof registry.inspect !== "function") throw new TypeError("registry.inspect is required");
  if (!lifecycleStore || typeof lifecycleStore.read !== "function"
    || typeof lifecycleStore.prepareCleanup !== "function"
    || typeof lifecycleStore.completeCleanup !== "function") {
    throw new TypeError("migration lifecycle cleanup store is required");
  }
  if (!nonEmptyString(home)) throw new TypeError("home is required");
  if (typeof readActivationReceipt !== "function") throw new TypeError("readActivationReceipt is required");

  return Object.freeze({
    async cleanup({ projectId, commandId } = {}) {
      if (!nonEmptyString(projectId) || !nonEmptyString(commandId)) {
        return { ok: false, code: "MIGRATION_CLEANUP_INVALID" };
      }
      const project = registry.inspect(projectId);
      if (!project) return { ok: false, code: "MIGRATION_NOT_FOUND" };

      const lifecycle = await lifecycleStore.read(projectId);
      if (!lifecycle?.ok) return lifecycle;
      const manifest = lifecycle.manifest;
      if (!manifest) return { ok: false, code: "MIGRATION_NOT_FOUND" };
      if (manifest.projectId !== projectId || manifest.projectLineageId !== project.lineageId
        || manifest.workspace !== project.workspace?.canonicalRoot) {
        return blocked("MIGRATION_PROJECT_MISMATCH");
      }

      const activation = await readActivationReceipt({ home, projectId });
      if (!activation?.ok) return activation;
      if (!activation.receipt) return { ok: false, code: "MIGRATION_CLEANUP_NOT_VERIFIED" };
      const inventoryDigest = manifestInventoryDigest(manifest);
      if (!receiptMatches({ receipt: activation.receipt, project, manifest, inventoryDigest })) {
        return blocked("MIGRATION_ACTIVATION_RECEIPT_STALE");
      }
      const thinShims = [...activation.receipt.thinShims].sort((left, right) => left.localeCompare(right, "en"));
      if (thinShims.some((path) => !cleanRelativePath(path))) return blocked("MIGRATION_ACTIVATION_RECEIPT_CORRUPT");

      const originalManaged = originalManagedEntries(manifest);
      if (originalManaged === null) return blocked("MIGRATION_MANIFEST_CORRUPT");
      const removedPaths = originalManaged
        .filter((entry) => !thinShims.includes(entry.path))
        .map((entry) => entry.path)
        .sort((left, right) => left.localeCompare(right, "en"));

      const existingCleanup = manifest.cleanup ?? null;
      const resume = existingCleanup?.state === "PREPARED" && existingCleanup.commandId === commandId;
      if (existingCleanup) {
        const prepared = await lifecycleStore.prepareCleanup({
          projectId,
          commandId,
          inventoryDigest,
          removedPaths,
          thinShims,
        });
        if (!prepared.ok) return prepared;
        if (prepared.complete) {
          return {
            ok: true,
            code: "MIGRATION_CLEANUP_COMPLETE",
            manifest: prepared.manifest,
            removedPaths,
            replayed: true,
          };
        }
      }

      let workspaceRoot;
      try {
        workspaceRoot = await realpath(resolve(project.workspace.canonicalRoot));
      } catch {
        return blocked("MIGRATION_WORKSPACE_UNREADABLE");
      }
      if (workspaceRoot !== project.workspace.canonicalRoot) return blocked("MIGRATION_PROJECT_MISMATCH");

      const preflight = await scanBeforeCleanup({ workspaceRoot, manifest, thinShims, resume });
      if (!preflight.ok) return preflight;

      if (!existingCleanup) {
        const prepared = await lifecycleStore.prepareCleanup({
          projectId,
          commandId,
          inventoryDigest,
          removedPaths,
          thinShims,
        });
        if (!prepared.ok) return prepared;
      }

      const deleted = await deletePreparedFiles(workspaceRoot, preflight.removable);
      if (!deleted.ok) return deleted;
      const verified = await verifyAfterCleanup({ workspaceRoot, thinShims });
      if (!verified.ok) return verified;

      const completed = await lifecycleStore.completeCleanup({ projectId, commandId });
      if (!completed.ok) return completed;
      return {
        ok: true,
        code: "MIGRATION_CLEANUP_COMPLETE",
        manifest: completed.manifest,
        removedPaths,
        replayed: completed.replayed === true,
      };
    },
  });
}
