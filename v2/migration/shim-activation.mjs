import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const RECEIPT_SCHEMA = "orchestra.migration-activation.v2";
const BACKUP_SCHEMA = "orchestra.migration-integration-backup.v2";
const ALLOWED_PROVIDERS = Object.freeze(["antigravity", "codex"]);
const ALLOWED_SHIMS = new Set([
  ".agents/hooks.json",
  ".agents/orchestra-v2-hook.mjs",
  ".codex/hooks.json",
  ".codex/orchestra-v2-hook.mjs",
]);

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

function bytesDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function projectKey(projectId) {
  return createHash("sha256").update(projectId, "utf8").digest("hex");
}

function receiptFile(home, projectId) {
  return join(home, "migration", "activations", `${projectKey(projectId)}.json`);
}

function backupFile(home, projectId) {
  return join(home, "migration", "integration-backups", `${projectKey(projectId)}.json`);
}

function normalizeProviders(providers) {
  if (!Array.isArray(providers) || providers.length === 0) return null;
  const normalized = [...new Set(providers)].sort();
  if (normalized.some((provider) => !ALLOWED_PROVIDERS.includes(provider))) return null;
  return normalized;
}

function expectedShimPaths(provider) {
  return provider === "codex"
    ? [".codex/hooks.json", ".codex/orchestra-v2-hook.mjs"]
    : [".agents/hooks.json", ".agents/orchestra-v2-hook.mjs"];
}

function expectedPathsForProviders(providers) {
  return [...new Set(providers.flatMap(expectedShimPaths))].sort();
}

function validReceipt(receipt, projectId = null) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  if (receipt.schema !== RECEIPT_SCHEMA || !nonEmptyString(receipt.projectId)) return false;
  if (projectId !== null && receipt.projectId !== projectId) return false;
  if (!nonEmptyString(receipt.projectLineageId) || !nonEmptyString(receipt.workspace)) return false;
  if (receipt.integrationMode !== "V2_GLOBAL" || receipt.verified !== true || receipt.cleanupEligible !== true) return false;
  if (!Array.isArray(receipt.providers) || receipt.providers.length === 0) return false;
  if (normalizeProviders(receipt.providers)?.join("\0") !== receipt.providers.join("\0")) return false;
  if (!Array.isArray(receipt.thinShims) || receipt.thinShims.some((path) => !ALLOWED_SHIMS.has(path))) return false;
  if (receipt.globalStatusVerified !== true || typeof receipt.recoveryVerified !== "boolean") return false;
  if (!nonEmptyString(receipt.runtimeImage) || !Number.isInteger(receipt.instructionEpoch) || receipt.instructionEpoch < 0) return false;
  if (!/^sha256:[0-9a-f]{64}$/.test(receipt.inventoryDigest ?? "")) return false;
  if (!nonEmptyString(receipt.verifiedAt) || !Number.isFinite(Date.parse(receipt.verifiedAt))) return false;
  return true;
}

function validBackup(backup, { projectId = null, workspace = null } = {}) {
  if (!backup || typeof backup !== "object" || Array.isArray(backup)) return false;
  if (backup.schema !== BACKUP_SCHEMA || !nonEmptyString(backup.projectId)) return false;
  if (projectId !== null && backup.projectId !== projectId) return false;
  if (!nonEmptyString(backup.projectLineageId) || !nonEmptyString(backup.workspace)) return false;
  if (workspace !== null && backup.workspace !== workspace) return false;
  if (!Array.isArray(backup.providers) || normalizeProviders(backup.providers)?.join("\0") !== backup.providers.join("\0")) return false;
  const expected = expectedPathsForProviders(backup.providers);
  if (!Array.isArray(backup.files) || backup.files.length !== expected.length) return false;
  if (!nonEmptyString(backup.createdAt) || !Number.isFinite(Date.parse(backup.createdAt))) return false;
  const paths = backup.files.map((file) => file?.path);
  if (paths.join("\0") !== expected.join("\0")) return false;
  for (const file of backup.files) {
    if (!ALLOWED_SHIMS.has(file.path) || typeof file.existed !== "boolean") return false;
    if (!file.existed) {
      if (file.contentBase64 !== null || file.digest !== null || file.mode !== null) return false;
      continue;
    }
    if (!nonEmptyString(file.contentBase64) || !/^sha256:[0-9a-f]{64}$/.test(file.digest ?? "")) return false;
    if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) return false;
    let bytes;
    try {
      bytes = Buffer.from(file.contentBase64, "base64");
    } catch {
      return false;
    }
    if (bytes.toString("base64") !== file.contentBase64 || bytesDigest(bytes) !== file.digest) return false;
  }
  return true;
}

async function readJsonOrNull(path, corruptCode) {
  try {
    return { ok: true, value: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, value: null };
    return { ok: false, code: corruptCode };
  }
}

async function unlinkIfExists(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await unlinkIfExists(temp).catch(() => {});
    throw error;
  }
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function validateShimParents(workspace, relativePath) {
  if (!ALLOWED_SHIMS.has(relativePath)) return { ok: false, code: "MIGRATION_SHIM_PATH_UNSAFE" };
  const parts = relativePath.split("/");
  let current = workspace;
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = join(current, parts[index]);
    const stat = await lstatOrNull(current);
    if (stat === null) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { ok: false, code: "MIGRATION_SHIM_PATH_UNSAFE", path: relativePath };
    }
  }
  return { ok: true };
}

async function captureFile(workspace, relativePath) {
  const parents = await validateShimParents(workspace, relativePath);
  if (!parents.ok) return parents;
  const path = join(workspace, ...relativePath.split("/"));
  const stat = await lstatOrNull(path);
  if (stat === null) {
    return {
      ok: true,
      file: { path: relativePath, existed: false, contentBase64: null, digest: null, mode: null },
    };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { ok: false, code: "MIGRATION_SHIM_PATH_UNSAFE", path: relativePath };
  }
  const bytes = await readFile(path);
  return {
    ok: true,
    file: {
      path: relativePath,
      existed: true,
      contentBase64: bytes.toString("base64"),
      digest: bytesDigest(bytes),
      mode: stat.mode & 0o777,
    },
  };
}

async function ensureIntegrationBackup({ home, project, providers, now }) {
  const path = backupFile(home, project.projectId);
  const existing = await readJsonOrNull(path, "MIGRATION_INTEGRATION_BACKUP_CORRUPT");
  if (!existing.ok) return existing;
  if (existing.value !== null) {
    if (!validBackup(existing.value, { projectId: project.projectId, workspace: project.workspace.canonicalRoot })
      || existing.value.projectLineageId !== project.lineageId
      || existing.value.providers.join("\0") !== providers.join("\0")) {
      return { ok: false, code: "MIGRATION_INTEGRATION_BACKUP_CONFLICT" };
    }
    return { ok: true, backup: existing.value, replayed: true };
  }

  const files = [];
  for (const relativePath of expectedPathsForProviders(providers)) {
    const captured = await captureFile(project.workspace.canonicalRoot, relativePath);
    if (!captured.ok) return captured;
    files.push(captured.file);
  }
  const backup = {
    schema: BACKUP_SCHEMA,
    projectId: project.projectId,
    projectLineageId: project.lineageId,
    workspace: project.workspace.canonicalRoot,
    providers,
    files,
    createdAt: now(),
  };
  try {
    await writeJsonAtomic(path, backup);
  } catch (error) {
    return {
      ok: false,
      code: "MIGRATION_INTEGRATION_BACKUP_WRITE_FAILED",
      reason: error?.code ?? error?.message ?? "UNKNOWN",
    };
  }
  return { ok: true, backup, replayed: false };
}

export async function readMigrationActivationReceipt({ home, projectId } = {}) {
  if (!nonEmptyString(home) || !nonEmptyString(projectId)) {
    return { ok: false, code: "MIGRATION_ACTIVATION_RECEIPT_INPUT_INVALID", receipt: null };
  }
  const loaded = await readJsonOrNull(receiptFile(home, projectId), "MIGRATION_ACTIVATION_RECEIPT_CORRUPT");
  if (!loaded.ok) return { ...loaded, receipt: null };
  if (loaded.value === null) return { ok: true, receipt: null };
  if (!validReceipt(loaded.value, projectId)) {
    return { ok: false, code: "MIGRATION_ACTIVATION_RECEIPT_CORRUPT", receipt: null };
  }
  return { ok: true, receipt: loaded.value };
}

export async function restoreMigrationIntegration({ home, projectId, workspace = null } = {}) {
  if (!nonEmptyString(home) || !nonEmptyString(projectId)) {
    return { ok: false, code: "MIGRATION_INTEGRATION_RESTORE_INPUT_INVALID" };
  }
  const path = backupFile(home, projectId);
  const loaded = await readJsonOrNull(path, "MIGRATION_INTEGRATION_BACKUP_CORRUPT");
  if (!loaded.ok) return loaded;
  if (loaded.value === null) {
    return { ok: true, restored: false, restoredPaths: [], removedPaths: [] };
  }
  const backup = loaded.value;
  if (!validBackup(backup, { projectId, workspace })) {
    return { ok: false, code: "MIGRATION_INTEGRATION_BACKUP_CORRUPT" };
  }

  const restoredPaths = [];
  const removedPaths = [];
  try {
    for (const file of backup.files) {
      const parents = await validateShimParents(backup.workspace, file.path);
      if (!parents.ok) return parents;
      const target = join(backup.workspace, ...file.path.split("/"));
      const current = await lstatOrNull(target);
      if (current?.isSymbolicLink() || (current && !current.isFile())) {
        return { ok: false, code: "MIGRATION_SHIM_PATH_UNSAFE", path: file.path };
      }
      if (!file.existed) {
        if (current) {
          await unlink(target);
          removedPaths.push(file.path);
        }
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      const parentsAfterMkdir = await validateShimParents(backup.workspace, file.path);
      if (!parentsAfterMkdir.ok) return parentsAfterMkdir;
      const bytes = Buffer.from(file.contentBase64, "base64");
      await writeFile(target, bytes, { mode: file.mode });
      restoredPaths.push(file.path);
    }
    await unlinkIfExists(path);
    await unlinkIfExists(receiptFile(home, projectId));
  } catch (error) {
    return {
      ok: false,
      code: "MIGRATION_INTEGRATION_RESTORE_FAILED",
      reason: error?.code ?? error?.message ?? "UNKNOWN",
      restoredPaths,
      removedPaths,
    };
  }
  return { ok: true, restored: true, restoredPaths, removedPaths };
}

function verificationFailure(verification, providers, recoveryRequired) {
  if (!verification || typeof verification !== "object" || verification.ok !== true) {
    return "MIGRATION_V2_VERIFICATION_REQUIRED";
  }
  if (verification.mode !== "V2_GLOBAL" || verification.fallbackUsed === true) {
    return "MIGRATION_V1_FALLBACK_DETECTED";
  }
  if (verification.globalStatus?.ok !== true) {
    return "MIGRATION_GLOBAL_STATUS_VERIFICATION_REQUIRED";
  }
  for (const provider of providers) {
    const result = verification.providers?.[provider];
    if (result?.sessionStart !== true || result?.attached !== true) {
      return "MIGRATION_PROVIDER_SESSION_VERIFICATION_REQUIRED";
    }
  }
  if (recoveryRequired && verification.recovery?.ok !== true) {
    return "MIGRATION_RECOVERY_VERIFICATION_REQUIRED";
  }
  return null;
}

function inventoryDigest(manifest) {
  return digest((manifest.inventory ?? []).map((item) => ({
    path: item.path ?? null,
    digest: item.digest ?? null,
    category: item.category ?? null,
    disposition: item.disposition ?? null,
    private: item.private === true,
  })));
}

function normalizeInstalledFiles(provider, result) {
  if (!result?.ok || !Array.isArray(result.files)) return null;
  const expected = new Set(expectedShimPaths(provider));
  const files = [...new Set(result.files)].sort();
  if (files.length !== expected.size || files.some((path) => !expected.has(path))) return null;
  return files;
}

async function failAfterMutation({ home, projectId, workspace, failure }) {
  const restored = await restoreMigrationIntegration({ home, projectId, workspace });
  if (!restored.ok) {
    return {
      ok: false,
      code: "MIGRATION_ACTIVATION_ROLLBACK_FAILED",
      reason: restored.code,
      originalCode: failure.code,
      originalReason: failure.reason ?? null,
      cleanupEligible: false,
    };
  }
  return { ...failure, integrationRestored: restored.restored === true };
}

export function createMigrationShimActivator({
  registry,
  lifecycleStore,
  home,
  launcherPath,
  nodePath = process.execPath,
  verify,
  codexInstaller,
  antigravityInstaller,
  now = () => new Date().toISOString(),
} = {}) {
  if (!registry || typeof registry.inspect !== "function") throw new TypeError("registry.inspect is required");
  if (!lifecycleStore || typeof lifecycleStore.read !== "function") throw new TypeError("lifecycleStore.read is required");
  if (!nonEmptyString(home) || !nonEmptyString(launcherPath) || !nonEmptyString(nodePath)) {
    throw new TypeError("home, launcherPath, and nodePath are required");
  }
  if (typeof verify !== "function") throw new TypeError("verify is required");
  if (typeof codexInstaller !== "function" || typeof antigravityInstaller !== "function") {
    throw new TypeError("provider shim installers are required");
  }

  return Object.freeze({
    async activate({ projectId, providers } = {}) {
      if (!nonEmptyString(projectId)) {
        return { ok: false, code: "MIGRATION_PROJECT_ID_INVALID", cleanupEligible: false };
      }
      const normalizedProviders = normalizeProviders(providers);
      if (!normalizedProviders) {
        return { ok: false, code: "MIGRATION_PROVIDER_SET_INVALID", cleanupEligible: false };
      }

      const lifecycle = await lifecycleStore.read(projectId);
      if (!lifecycle?.ok) return { ...lifecycle, cleanupEligible: false };
      const manifest = lifecycle.manifest;
      if (!manifest) return { ok: false, code: "MIGRATION_NOT_FOUND", cleanupEligible: false };
      if (manifest.status !== "IMPORTED" || manifest.active !== true) {
        return { ok: false, code: "MIGRATION_NOT_ACTIVE", cleanupEligible: false };
      }

      const project = registry.inspect(projectId);
      if (!project || project.workspace?.canonicalRoot !== manifest.workspace) {
        return { ok: false, code: "MIGRATION_PROJECT_MISMATCH", cleanupEligible: false };
      }

      const existing = await readMigrationActivationReceipt({ home, projectId });
      if (!existing.ok) return { ...existing, cleanupEligible: false };
      if (existing.receipt) {
        const sameProviders = existing.receipt.providers.join("\0") === normalizedProviders.join("\0");
        const sameInventory = existing.receipt.inventoryDigest === inventoryDigest(manifest);
        const sameRuntime = existing.receipt.runtimeImage === project.runtime?.pinnedImage
          && existing.receipt.instructionEpoch === project.runtime?.instructionEpoch;
        if (!sameProviders || !sameInventory || !sameRuntime) {
          return { ok: false, code: "MIGRATION_ACTIVATION_CONFLICT", cleanupEligible: false };
        }
        return {
          ok: true,
          code: "MIGRATION_V2_ACTIVATED",
          cleanupEligible: true,
          receipt: existing.receipt,
          replayed: true,
        };
      }

      const backup = await ensureIntegrationBackup({
        home,
        project,
        providers: normalizedProviders,
        now,
      });
      if (!backup.ok) return { ...backup, cleanupEligible: false };

      const thinShims = [];
      try {
        for (const provider of normalizedProviders) {
          const installed = provider === "codex"
            ? await codexInstaller({
              targetDir: project.workspace.canonicalRoot,
              launcherPath,
              nodePath,
              orchestraHome: home,
            })
            : await antigravityInstaller({
              registry,
              projectId,
              targetDir: project.workspace.canonicalRoot,
              launcherPath,
              nodePath,
            });
          const files = normalizeInstalledFiles(provider, installed);
          if (!files) {
            return await failAfterMutation({
              home,
              projectId,
              workspace: project.workspace.canonicalRoot,
              failure: {
                ok: false,
                code: "MIGRATION_SHIM_INSTALL_FAILED",
                provider,
                cleanupEligible: false,
              },
            });
          }
          thinShims.push(...files);
        }
      } catch (error) {
        return failAfterMutation({
          home,
          projectId,
          workspace: project.workspace.canonicalRoot,
          failure: {
            ok: false,
            code: "MIGRATION_SHIM_INSTALL_FAILED",
            reason: error?.code ?? error?.message ?? "UNKNOWN",
            cleanupEligible: false,
          },
        });
      }

      let verification;
      try {
        verification = await verify({
          project,
          providers: normalizedProviders,
          manifest,
          thinShims: [...thinShims].sort(),
        });
      } catch (error) {
        return failAfterMutation({
          home,
          projectId,
          workspace: project.workspace.canonicalRoot,
          failure: {
            ok: false,
            code: "MIGRATION_V2_VERIFICATION_FAILED",
            reason: error?.code ?? error?.message ?? "MIGRATION_V2_VERIFICATION_REQUIRED",
            cleanupEligible: false,
          },
        });
      }

      const recoveryRequired = nonEmptyString(manifest.import?.recoveryWorkId);
      const failure = verificationFailure(verification, normalizedProviders, recoveryRequired);
      if (failure) {
        return failAfterMutation({
          home,
          projectId,
          workspace: project.workspace.canonicalRoot,
          failure: {
            ok: false,
            code: "MIGRATION_V2_VERIFICATION_FAILED",
            reason: failure,
            cleanupEligible: false,
          },
        });
      }

      const receipt = {
        schema: RECEIPT_SCHEMA,
        projectId,
        projectLineageId: project.lineageId,
        workspace: project.workspace.canonicalRoot,
        runtimeImage: project.runtime.pinnedImage,
        instructionEpoch: project.runtime.instructionEpoch,
        inventoryDigest: inventoryDigest(manifest),
        integrationMode: "V2_GLOBAL",
        verified: true,
        cleanupEligible: true,
        providers: normalizedProviders,
        thinShims: [...new Set(thinShims)].sort(),
        globalStatusVerified: true,
        recoveryVerified: recoveryRequired ? true : verification.recovery?.ok === true,
        verifiedAt: now(),
      };
      const path = receiptFile(home, projectId);
      try {
        await writeJsonAtomic(path, receipt);
      } catch (error) {
        return failAfterMutation({
          home,
          projectId,
          workspace: project.workspace.canonicalRoot,
          failure: {
            ok: false,
            code: "MIGRATION_ACTIVATION_RECEIPT_WRITE_FAILED",
            reason: error?.code ?? error?.message ?? "UNKNOWN",
            cleanupEligible: false,
          },
        });
      }
      return {
        ok: true,
        code: "MIGRATION_V2_ACTIVATED",
        cleanupEligible: true,
        receipt,
        replayed: false,
      };
    },
  });
}
