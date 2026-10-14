import { loadRuntimeManifest } from "../manifest-loader.mjs";
import {
  inspectProjectRuntime,
  installProjectRuntime,
  rollbackProjectRuntime,
  updateProjectRuntime,
} from "../project-runtime-manager.mjs";
import { delegationProjectRuntimeAdapter } from "./project-runtime-adapter.mjs";

export const DELEGATION_RUNTIME = "delegation";

async function manifest() {
  return loadRuntimeManifest(DELEGATION_RUNTIME);
}

export async function inspectDelegationProjectRuntime({ targetDir, builtRuntime }) {
  return inspectProjectRuntime({ targetDir, builtRuntime, runtimeManifest: await manifest() });
}

export async function installDelegationProjectRuntime({
  targetDir,
  builtRuntime,
  adapter = delegationProjectRuntimeAdapter,
}) {
  return installProjectRuntime({
    targetDir,
    builtRuntime,
    adapter,
    runtimeManifest: await manifest(),
  });
}

export async function updateDelegationProjectRuntime({
  targetDir,
  builtRuntime,
  adapter = delegationProjectRuntimeAdapter,
  dryRun = false,
  force = false,
}) {
  return updateProjectRuntime({
    targetDir,
    builtRuntime,
    adapter,
    dryRun,
    force,
    runtimeManifest: await manifest(),
  });
}

export async function ensureDelegationProjectRuntime({
  targetDir,
  builtRuntime,
  adapter = delegationProjectRuntimeAdapter,
  dryRun = false,
  force = false,
}) {
  return updateDelegationProjectRuntime({ targetDir, builtRuntime, adapter, dryRun, force });
}

export async function rollbackDelegationProjectRuntime({
  targetDir,
  backupId,
  adapter = delegationProjectRuntimeAdapter,
  force = false,
}) {
  return rollbackProjectRuntime({
    targetDir,
    backupId,
    adapter,
    force,
    runtimeManifest: await manifest(),
  });
}
