import { loadRuntimeManifest } from "../../runtime/manifest-loader.mjs";
import {
  inspectProjectRuntime,
  installProjectRuntime,
  rollbackProjectRuntime,
  updateProjectRuntime,
} from "../../runtime/project-runtime-manager.mjs";

export const CODEX_RUNTIME = "codex";

async function manifest() {
  return loadRuntimeManifest(CODEX_RUNTIME);
}

export async function inspectCodexProjectRuntime({ targetDir, builtRuntime }) {
  return inspectProjectRuntime({ targetDir, builtRuntime, runtimeManifest: await manifest() });
}

export async function installCodexProjectRuntime({ targetDir, builtRuntime, adapter = null }) {
  return installProjectRuntime({ targetDir, builtRuntime, adapter, runtimeManifest: await manifest() });
}

export async function updateCodexProjectRuntime({ targetDir, builtRuntime, adapter = null, dryRun = false, force = false }) {
  return updateProjectRuntime({ targetDir, builtRuntime, adapter, dryRun, force, runtimeManifest: await manifest() });
}

export async function rollbackCodexProjectRuntime({ targetDir, backupId, adapter = null, force = false }) {
  return rollbackProjectRuntime({ targetDir, backupId, adapter, force, runtimeManifest: await manifest() });
}
