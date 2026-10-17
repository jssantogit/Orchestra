import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const RECEIPT_SCHEMA = "orchestra.migration-activation.v2";
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

function receiptFile(home, projectId) {
  const key = createHash("sha256").update(projectId, "utf8").digest("hex");
  return join(home, "migration", "activations", `${key}.json`);
}

function normalizeProviders(providers) {
  if (!Array.isArray(providers) || providers.length === 0) return null;
  const normalized = [...new Set(providers)].sort();
  if (normalized.some((provider) => !ALLOWED_PROVIDERS.includes(provider))) return null;
  return normalized;
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

export async function readMigrationActivationReceipt({ home, projectId } = {}) {
  if (!nonEmptyString(home) || !nonEmptyString(projectId)) {
    return { ok: false, code: "MIGRATION_ACTIVATION_RECEIPT_INPUT_INVALID", receipt: null };
  }
  try {
    const parsed = JSON.parse(await readFile(receiptFile(home, projectId), "utf8"));
    if (!validReceipt(parsed, projectId)) {
      return { ok: false, code: "MIGRATION_ACTIVATION_RECEIPT_CORRUPT", receipt: null };
    }
    return { ok: true, receipt: parsed };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, receipt: null };
    return { ok: false, code: "MIGRATION_ACTIVATION_RECEIPT_CORRUPT", receipt: null };
  }
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

function expectedShimPaths(provider) {
  return provider === "codex"
    ? [".codex/hooks.json", ".codex/orchestra-v2-hook.mjs"]
    : [".agents/hooks.json", ".agents/orchestra-v2-hook.mjs"];
}

function normalizeInstalledFiles(provider, result) {
  if (!result?.ok || !Array.isArray(result.files)) return null;
  const expected = new Set(expectedShimPaths(provider));
  const files = [...new Set(result.files)].sort();
  if (files.length !== expected.size || files.some((path) => !expected.has(path))) return null;
  return files;
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
            return {
              ok: false,
              code: "MIGRATION_SHIM_INSTALL_FAILED",
              provider,
              cleanupEligible: false,
            };
          }
          thinShims.push(...files);
        }
      } catch (error) {
        return {
          ok: false,
          code: "MIGRATION_SHIM_INSTALL_FAILED",
          reason: error?.code ?? error?.message ?? "UNKNOWN",
          cleanupEligible: false,
        };
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
        return {
          ok: false,
          code: "MIGRATION_V2_VERIFICATION_FAILED",
          reason: error?.code ?? error?.message ?? "MIGRATION_V2_VERIFICATION_REQUIRED",
          cleanupEligible: false,
        };
      }

      const recoveryRequired = nonEmptyString(manifest.import?.recoveryWorkId);
      const failure = verificationFailure(verification, normalizedProviders, recoveryRequired);
      if (failure) {
        return {
          ok: false,
          code: "MIGRATION_V2_VERIFICATION_FAILED",
          reason: failure,
          cleanupEligible: false,
        };
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
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temp, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", flag: "wx" });
        await rename(temp, path);
      } catch (error) {
        return {
          ok: false,
          code: "MIGRATION_ACTIVATION_RECEIPT_WRITE_FAILED",
          reason: error?.code ?? error?.message ?? "UNKNOWN",
          cleanupEligible: false,
        };
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
