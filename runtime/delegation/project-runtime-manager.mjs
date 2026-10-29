import { loadRuntimeManifest } from "../manifest-loader.mjs";
import {
  inspectProjectRuntime,
  installProjectRuntime,
  rollbackProjectRuntime,
  updateProjectRuntime,
  uninstallProjectRuntime,
} from "../project-runtime-manager.mjs";
import { delegationProjectRuntimeAdapter } from "./project-runtime-adapter.mjs";

export const DELEGATION_RUNTIME = "delegation";

async function manifest() {
  return loadRuntimeManifest(DELEGATION_RUNTIME);
}

export async function inspectDelegationProjectRuntime({ targetDir, builtRuntime }) {
  return inspectProjectRuntime({ targetDir, builtRuntime, runtimeManifest: await manifest() });
}

export async function doctorDelegationProjectRuntime({ targetDir, builtRuntime }) {
  const inspection = await inspectDelegationProjectRuntime({ targetDir, builtRuntime });
  const checks = [
    {
      id: "DELEGATION_RUNTIME_INSTALLED",
      ok: inspection.installed,
      detail: inspection.installed ? "delegation runtime is installed" : "delegation runtime is not installed",
    },
    {
      id: "DELEGATION_RUNTIME_METADATA",
      ok: inspection.managed && inspection.metadata?.schema === "orchestra.project-runtime.v2",
      detail: inspection.metadata?.schema || "missing .orchestra/state/runtimes/delegation.json",
    },
    {
      id: "DELEGATION_RUNTIME_INTEGRITY",
      ok: inspection.diff.clean,
      detail: inspection.diff.clean ? "installed delegation runtime matches built payload" : "delegation runtime drift detected",
    },
    {
      id: "DELEGATION_RUNTIME_METADATA_CURRENT",
      ok: inspection.metadataCurrent,
      detail: inspection.metadataCurrent ? "delegation runtime metadata matches current manifest and payload" : "delegation runtime metadata is stale or inconsistent",
    },
  ];
  const healthy = checks.every((check) => check.ok);
  return {
    healthy,
    status: healthy ? "HEALTHY" : "UNHEALTHY",
    targetDir,
    runtime: "DELEGATION",
    metadata: inspection.metadata,
    inspection,
    checks,
  };
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

export async function uninstallDelegationProjectRuntime({ targetDir, adapter = delegationProjectRuntimeAdapter, dryRun = false }) {
  return uninstallProjectRuntime({ targetDir, runtimeManifest: await manifest(), adapter, dryRun });
}
