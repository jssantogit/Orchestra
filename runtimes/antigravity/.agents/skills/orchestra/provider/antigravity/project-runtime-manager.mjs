import { loadRuntimeManifest } from "../../runtime/manifest-loader.mjs";
import {
  inspectProjectRuntime,
  installProjectRuntime,
  rollbackProjectRuntime,
  updateProjectRuntime,
} from "../../runtime/project-runtime-manager.mjs";

export const ANTIGRAVITY_RUNTIME = "antigravity";

async function manifest() {
  return loadRuntimeManifest(ANTIGRAVITY_RUNTIME);
}

export async function inspectAntigravityProjectRuntime({ targetDir, builtRuntime }) {
  return inspectProjectRuntime({ targetDir, builtRuntime, runtimeManifest: await manifest() });
}

export async function installAntigravityProjectRuntime({ targetDir, builtRuntime, adapter = null }) {
  return installProjectRuntime({ targetDir, builtRuntime, adapter, runtimeManifest: await manifest() });
}

export async function updateAntigravityProjectRuntime({ targetDir, builtRuntime, adapter = null, dryRun = false, force = false }) {
  return updateProjectRuntime({ targetDir, builtRuntime, adapter, dryRun, force, runtimeManifest: await manifest() });
}

export async function rollbackAntigravityProjectRuntime({ targetDir, backupId, adapter = null, force = false }) {
  return rollbackProjectRuntime({ targetDir, backupId, adapter, force, runtimeManifest: await manifest() });
}
