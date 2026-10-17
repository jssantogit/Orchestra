import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MANIFEST_SCHEMA = "orchestra.migration-manifest.v2";

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

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex")}`;
}

function manifestFile(root, projectId) {
  const key = createHash("sha256").update(projectId, "utf8").digest("hex");
  return join(root, `${key}.json`);
}

function normalizeInventory(inventory, classifications) {
  const byPath = new Map(classifications.map((item) => [item.path, item]));
  return inventory.map((item) => ({
    path: item.path,
    digest: item.digest ?? null,
    category: item.category ?? null,
    disposition: byPath.get(item.path)?.disposition ?? "UNSUPPORTED_BLOCKED",
    private: item.private === true,
  }));
}

function normalizePathList(paths) {
  if (!Array.isArray(paths) || paths.some((path) => !nonEmptyString(path))) return null;
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right, "en"));
}

function commandRequest(kind, fields) {
  return digest({ kind, ...fields });
}

async function readManifest(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed?.schema !== MANIFEST_SCHEMA || !nonEmptyString(parsed.projectId)) {
      return { ok: false, code: "MIGRATION_MANIFEST_CORRUPT" };
    }
    return { ok: true, manifest: parsed };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, manifest: null };
    return { ok: false, code: "MIGRATION_MANIFEST_CORRUPT" };
  }
}

async function writeManifest(root, path, manifest) {
  await mkdir(root, { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temp, path);
}

function findCommand(manifest, commandId) {
  return manifest.commands.find((entry) => entry.commandId === commandId) ?? null;
}

function serializeImport(importResult) {
  return {
    workId: importResult?.work?.workId ?? null,
    recoveryWorkId: importResult?.recoveryWork?.workId ?? null,
    recoveryGeneration: importResult?.recoveryWork?.generation ?? null,
    transient: (importResult?.transient ?? []).map((item) => ({
      path: item.path,
      digest: item.digest,
      operationId: item.operationId ?? null,
    })),
    archives: (importResult?.archives ?? []).map((item) => ({
      path: item.path,
      digest: item.digest,
      size: item.size,
      private: item.private === true,
    })),
  };
}

export function createMigrationLifecycleStore({ home, state = null, now = () => new Date().toISOString() } = {}) {
  if (!nonEmptyString(home)) throw new TypeError("home is required");
  const root = join(home, "migration", "manifests");

  return Object.freeze({
    async read(projectId) {
      if (!nonEmptyString(projectId)) return { ok: false, code: "MIGRATION_PROJECT_ID_INVALID" };
      return readManifest(manifestFile(root, projectId));
    },

    async recordApply({ project, workspace, commandId, inventory, classifications, importResult }) {
      if (!project || !nonEmptyString(project.projectId) || !nonEmptyString(workspace)
        || !nonEmptyString(commandId) || !Array.isArray(inventory) || !Array.isArray(classifications)) {
        return { ok: false, code: "MIGRATION_MANIFEST_INPUT_INVALID" };
      }
      const path = manifestFile(root, project.projectId);
      const current = await readManifest(path);
      if (!current.ok) return current;
      const normalizedInventory = normalizeInventory(inventory, classifications);
      const requestDigest = commandRequest("APPLY", {
        projectId: project.projectId,
        workspace: project.workspace?.canonicalRoot ?? workspace,
        inventory: normalizedInventory,
      });
      if (current.manifest) {
        const replay = findCommand(current.manifest, commandId);
        if (replay) {
          if (replay.kind !== "APPLY" || replay.requestDigest !== requestDigest) {
            return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
          }
          return { ok: true, manifest: current.manifest, replayed: true };
        }
      }

      const at = now();
      const manifest = current.manifest ?? {
        schema: MANIFEST_SCHEMA,
        projectId: project.projectId,
        projectLineageId: project.lineageId ?? null,
        workspace: project.workspace?.canonicalRoot ?? workspace,
        status: "IMPORTED",
        active: true,
        createdAt: at,
        updatedAt: at,
        inventory: normalizedInventory,
        import: serializeImport(importResult),
        integration: {
          mode: "LEGACY_COMPATIBILITY",
          verified: false,
          thinShims: [],
        },
        commands: [],
      };
      manifest.status = "IMPORTED";
      manifest.active = true;
      manifest.updatedAt = at;
      manifest.inventory = normalizedInventory;
      manifest.import = serializeImport(importResult);
      manifest.commands.push({ kind: "APPLY", commandId, requestDigest, at });
      await writeManifest(root, path, manifest);
      return { ok: true, manifest, replayed: false };
    },

    async prepareCleanup({ projectId, commandId, inventoryDigest, removedPaths, thinShims }) {
      const normalizedRemovedPaths = normalizePathList(removedPaths);
      const normalizedThinShims = normalizePathList(thinShims);
      if (!nonEmptyString(projectId) || !nonEmptyString(commandId)
        || !/^sha256:[0-9a-f]{64}$/.test(inventoryDigest ?? "")
        || normalizedRemovedPaths === null || normalizedThinShims === null) {
        return { ok: false, code: "MIGRATION_CLEANUP_INVALID" };
      }
      const path = manifestFile(root, projectId);
      const current = await readManifest(path);
      if (!current.ok) return current;
      if (!current.manifest) return { ok: false, code: "MIGRATION_NOT_FOUND" };
      const requestDigest = commandRequest("CLEANUP", {
        projectId,
        inventoryDigest,
        removedPaths: normalizedRemovedPaths,
        thinShims: normalizedThinShims,
      });
      const replay = findCommand(current.manifest, commandId);
      if (replay) {
        if (replay.kind !== "CLEANUP" || replay.requestDigest !== requestDigest) {
          return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
        }
        if (current.manifest.cleanup?.commandId !== commandId) {
          return { ok: false, code: "MIGRATION_MANIFEST_CORRUPT" };
        }
        return {
          ok: true,
          manifest: current.manifest,
          replayed: true,
          complete: current.manifest.cleanup.state === "COMPLETE",
        };
      }
      if (current.manifest.cleanup?.state === "PREPARED") {
        return { ok: false, code: "MIGRATION_CLEANUP_IN_PROGRESS" };
      }
      if (current.manifest.cleanup?.state === "COMPLETE" || current.manifest.status === "CLEANED") {
        return { ok: false, code: "MIGRATION_CLEANUP_ALREADY_COMPLETE" };
      }
      if (current.manifest.status !== "IMPORTED" || current.manifest.active !== true) {
        return { ok: false, code: "MIGRATION_CLEANUP_NOT_ACTIVE" };
      }

      const at = now();
      current.manifest.updatedAt = at;
      current.manifest.integration = {
        mode: "V2_GLOBAL",
        verified: true,
        thinShims: normalizedThinShims,
      };
      current.manifest.cleanup = {
        state: "PREPARED",
        commandId,
        requestDigest,
        inventoryDigest,
        removedPaths: normalizedRemovedPaths,
        thinShims: normalizedThinShims,
        preparedAt: at,
        completedAt: null,
      };
      current.manifest.commands.push({ kind: "CLEANUP", commandId, requestDigest, at });
      await writeManifest(root, path, current.manifest);
      return { ok: true, manifest: current.manifest, replayed: false, complete: false };
    },

    async completeCleanup({ projectId, commandId }) {
      if (!nonEmptyString(projectId) || !nonEmptyString(commandId)) {
        return { ok: false, code: "MIGRATION_CLEANUP_INVALID" };
      }
      const path = manifestFile(root, projectId);
      const current = await readManifest(path);
      if (!current.ok) return current;
      if (!current.manifest) return { ok: false, code: "MIGRATION_NOT_FOUND" };
      const cleanup = current.manifest.cleanup;
      if (!cleanup || cleanup.commandId !== commandId) {
        return { ok: false, code: "MIGRATION_CLEANUP_NOT_PREPARED" };
      }
      if (cleanup.state === "COMPLETE") {
        return { ok: true, manifest: current.manifest, replayed: true };
      }
      if (cleanup.state !== "PREPARED") {
        return { ok: false, code: "MIGRATION_MANIFEST_CORRUPT" };
      }

      const at = now();
      cleanup.state = "COMPLETE";
      cleanup.completedAt = at;
      current.manifest.status = "CLEANED";
      current.manifest.active = true;
      current.manifest.updatedAt = at;
      await writeManifest(root, path, current.manifest);
      return { ok: true, manifest: current.manifest, replayed: false };
    },

    async rollback({ projectId, commandId }) {
      if (!nonEmptyString(projectId) || !nonEmptyString(commandId)) {
        return { ok: false, code: "MIGRATION_ROLLBACK_INVALID" };
      }
      const path = manifestFile(root, projectId);
      const current = await readManifest(path);
      if (!current.ok) return current;
      if (!current.manifest) return { ok: false, code: "MIGRATION_NOT_FOUND" };
      if (current.manifest.cleanup?.state === "PREPARED" || current.manifest.cleanup?.state === "COMPLETE"
        || current.manifest.status === "CLEANED") {
        return {
          ok: false,
          code: "MIGRATION_ROLLBACK_BLOCKED",
          reason: "MIGRATION_CLEANUP_ACCEPTED",
        };
      }
      const requestDigest = commandRequest("ROLLBACK", { projectId });
      const replay = findCommand(current.manifest, commandId);
      if (replay) {
        if (replay.kind !== "ROLLBACK" || replay.requestDigest !== requestDigest) {
          return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
        }
        return { ok: true, manifest: current.manifest, replayed: true };
      }

      const recoveryWorkId = current.manifest.import?.recoveryWorkId ?? null;
      if (recoveryWorkId && state?.work?.current && state?.work?.abandonCurrent) {
        const active = state.work.current(projectId);
        if (active?.workId === recoveryWorkId) {
          const abandoned = state.work.abandonCurrent({
            projectId,
            expectedWorkId: active.workId,
            expectedGeneration: active.generation,
            commandId: `migration-rollback:${commandId}`,
            reason: "MIGRATION_ROLLBACK",
          });
          if (!abandoned?.ok) {
            return {
              ok: false,
              code: "MIGRATION_ROLLBACK_BLOCKED",
              reason: abandoned?.reason ?? null,
              actionRequired: "RECONCILE_MIGRATION_RECOVERY_WORK",
            };
          }
        }
      }

      const at = now();
      current.manifest.status = "ROLLED_BACK";
      current.manifest.active = false;
      current.manifest.updatedAt = at;
      current.manifest.integration = {
        ...(current.manifest.integration ?? {}),
        mode: "LEGACY_COMPATIBILITY",
        verified: false,
      };
      current.manifest.commands.push({ kind: "ROLLBACK", commandId, requestDigest, at });
      await writeManifest(root, path, current.manifest);
      return { ok: true, manifest: current.manifest, replayed: false };
    },
  });
}
