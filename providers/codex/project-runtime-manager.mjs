import { loadRuntimeManifest } from "../../runtime/manifest-loader.mjs";
import {
  inspectProjectRuntime,
  installProjectRuntime,
  rollbackProjectRuntime,
  updateProjectRuntime,
  uninstallProjectRuntime,
} from "../../runtime/project-runtime-manager.mjs";
import { codexProjectRuntimeAdapter } from "./project-runtime-adapter.mjs";

export const CODEX_RUNTIME = "codex";

async function manifest() {
  return loadRuntimeManifest(CODEX_RUNTIME);
}

export async function inspectCodexProjectRuntime({ targetDir, builtRuntime }) {
  return inspectProjectRuntime({ targetDir, builtRuntime, runtimeManifest: await manifest() });
}

export async function doctorCodexProjectRuntime({ targetDir, builtRuntime }) {
  const inspection = await inspectCodexProjectRuntime({ targetDir, builtRuntime });
  const checks = [
    {
      id: "INSTALLED",
      ok: inspection.installed,
      detail: inspection.installed ? "Codex runtime is installed" : "Codex runtime is not installed",
    },
    {
      id: "METADATA_V2",
      ok: inspection.managed && inspection.metadata?.schema === "orchestra.project-runtime.v2",
      detail: inspection.metadata?.schema || "missing .orchestra/state/runtimes/codex.json",
    },
    {
      id: "RUNTIME_INTEGRITY",
      ok: inspection.diff.clean,
      detail: inspection.diff.clean ? "installed runtime matches built payload" : "managed runtime drift detected",
    },
    {
      id: "METADATA_CURRENT",
      ok: inspection.metadataCurrent,
      detail: inspection.metadataCurrent ? "runtime metadata matches current manifest and payload" : "runtime metadata is stale or inconsistent",
    },
  ];
  const healthy = checks.every((check) => check.ok);
  return {
    healthy,
    status: healthy ? "HEALTHY" : "UNHEALTHY",
    targetDir,
    runtime: "CODEX",
    metadata: inspection.metadata,
    inspection,
    checks,
  };
}

export async function installCodexProjectRuntime({ targetDir, builtRuntime, adapter = codexProjectRuntimeAdapter }) {
  return installProjectRuntime({ targetDir, builtRuntime, adapter, runtimeManifest: await manifest() });
}

export async function updateCodexProjectRuntime({ targetDir, builtRuntime, adapter = codexProjectRuntimeAdapter, dryRun = false, force = false }) {
  return updateProjectRuntime({ targetDir, builtRuntime, adapter, dryRun, force, runtimeManifest: await manifest() });
}

export async function rollbackCodexProjectRuntime({ targetDir, backupId, adapter = codexProjectRuntimeAdapter, force = false }) {
  return rollbackProjectRuntime({ targetDir, backupId, adapter, force, runtimeManifest: await manifest() });
}

export async function uninstallCodexProjectRuntime({ targetDir, adapter = codexProjectRuntimeAdapter, dryRun = false }) {
  return uninstallProjectRuntime({ targetDir, runtimeManifest: await manifest(), adapter, dryRun });
}
