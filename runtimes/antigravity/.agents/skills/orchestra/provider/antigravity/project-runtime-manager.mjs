import { loadRuntimeManifest } from "../../runtime/manifest-loader.mjs";
import {
  inspectProjectRuntime,
  installProjectRuntime,
  rollbackProjectRuntime,
  updateProjectRuntime,
} from "../../runtime/project-runtime-manager.mjs";
import { antigravityProjectRuntimeAdapter } from "./project-runtime-adapter.mjs";

export const ANTIGRAVITY_RUNTIME = "antigravity";

async function manifest() {
  return loadRuntimeManifest(ANTIGRAVITY_RUNTIME);
}

export async function inspectAntigravityProjectRuntime({ targetDir, builtRuntime }) {
  return inspectProjectRuntime({ targetDir, builtRuntime, runtimeManifest: await manifest() });
}

export async function doctorAntigravityProjectRuntime({ targetDir, builtRuntime }) {
  const inspection = await inspectAntigravityProjectRuntime({ targetDir, builtRuntime });
  const checks = [
    {
      id: "INSTALLED",
      ok: inspection.installed,
      detail: inspection.installed ? "Antigravity runtime is installed" : "Antigravity runtime is not installed",
    },
    {
      id: "METADATA_V2",
      ok: inspection.managed && inspection.metadata?.schema === "orchestra.project-runtime.v2",
      detail: inspection.metadata?.schema || "missing .orchestra/state/runtimes/antigravity.json",
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
    runtime: "ANTIGRAVITY",
    metadata: inspection.metadata,
    inspection,
    checks,
  };
}

export async function installAntigravityProjectRuntime({ targetDir, builtRuntime, adapter = antigravityProjectRuntimeAdapter }) {
  return installProjectRuntime({ targetDir, builtRuntime, adapter, runtimeManifest: await manifest() });
}

export async function updateAntigravityProjectRuntime({ targetDir, builtRuntime, adapter = antigravityProjectRuntimeAdapter, dryRun = false, force = false }) {
  return updateProjectRuntime({ targetDir, builtRuntime, adapter, dryRun, force, runtimeManifest: await manifest() });
}

export async function rollbackAntigravityProjectRuntime({ targetDir, backupId, adapter = antigravityProjectRuntimeAdapter, force = false }) {
  return rollbackProjectRuntime({ targetDir, backupId, adapter, force, runtimeManifest: await manifest() });
}
