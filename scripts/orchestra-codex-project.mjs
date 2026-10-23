#!/usr/bin/env node
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildRuntime } from "../runtime/runtime-builder.mjs";
import {
  doctorDelegationProjectRuntime,
  ensureDelegationProjectRuntime,
  uninstallDelegationProjectRuntime,
} from "../runtime/delegation/project-runtime-manager.mjs";
import {
  doctorCodexProjectRuntime,
  inspectCodexProjectRuntime,
  installCodexProjectRuntime,
  rollbackCodexProjectRuntime,
  updateCodexProjectRuntime,
  uninstallCodexProjectRuntime,
} from "../providers/codex/project-runtime-manager.mjs";
import {
  inspectProjectEvidence,
  formatEvidenceInspection,
} from "../runtimes/codex/.codex/astra-orchestra/evidence-inspector.mjs";

function flag(args, name) {
  return args.includes(name);
}

function positional(args) {
  return args.filter((arg) => !arg.startsWith("--"));
}

function printDiff(diff) {
  console.log("Added / missing:      " + diff.added.length);
  console.log("Removed / stale:      " + diff.removed.length);
  console.log("Changed:              " + diff.changed.length);
  console.log("Unchanged:            " + diff.unchanged.length);
  for (const path of diff.added) console.log("  ADD    " + path);
  for (const path of diff.removed) console.log("  REMOVE " + path);
  for (const path of diff.changed) console.log("  CHANGE " + path);
}

async function withBuiltCodexRuntime(callback) {
  const buildRoot = await mkdtemp(join(tmpdir(), "orchestra-codex-project-"));
  try {
    const builtRuntime = join(buildRoot, "codex");
    await buildRuntime({ runtime: "codex", outputDir: builtRuntime });
    return await callback(builtRuntime);
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
}

async function withBuiltCodexAndDelegationRuntimes(callback) {
  const buildRoot = await mkdtemp(join(tmpdir(), "orchestra-codex-project-"));
  try {
    const providerBuiltRuntime = join(buildRoot, "codex");
    const delegationBuiltRuntime = join(buildRoot, "delegation");
    await buildRuntime({ runtime: "codex", outputDir: providerBuiltRuntime });
    await buildRuntime({ runtime: "delegation", outputDir: delegationBuiltRuntime });
    return await callback({ providerBuiltRuntime, delegationBuiltRuntime });
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
}

function composedRuntimeResult(providerRuntime, providerResult, delegationResult) {
  return {
    ...providerResult,
    changed: providerResult.changed === true || delegationResult.changed === true,
    providerRuntime: { ...providerResult, runtime: providerRuntime },
    delegationRuntime: { ...delegationResult, runtime: "delegation" },
  };
}

function composedDoctorResult(providerResult, delegationResult) {
  const checks = [...providerResult.checks, ...delegationResult.checks];
  const healthy = providerResult.healthy && delegationResult.healthy;
  return {
    ...providerResult,
    healthy,
    status: healthy ? "HEALTHY" : "UNHEALTHY",
    checks,
    providerRuntime: providerResult.inspection,
    delegationRuntime: delegationResult.inspection,
    // Byte integrity does not tell us whether Codex loaded the project layer
    // or whether a user reviewed its non-managed hook definitions. This
    // distinction was exposed by the first F6D native 1.5 field test.
    hookActivation: {
      status: "UNVERIFIED",
      requiresUserReview: true,
      instructions: "Project .codex hooks require project trust and separate /hooks review/trust in an interactive Codex session. After approval, verify a factual SessionStart Work Lease and a protected tool. Do not bypass hook trust.",
    },
  };
}

async function installCodexWithDelegation({ targetDir, dryRun }) {
  return withBuiltCodexAndDelegationRuntimes(async ({ providerBuiltRuntime, delegationBuiltRuntime }) => {
    const providerInspection = await inspectCodexProjectRuntime({ targetDir, builtRuntime: providerBuiltRuntime });
    const providerResult = dryRun
      ? { operation: "install", changed: !providerInspection.clean, dryRun: true, targetDir: resolve(targetDir), inspection: providerInspection }
      : null;

    if (!dryRun && providerInspection.installed) {
      return installCodexProjectRuntime({ targetDir, builtRuntime: providerBuiltRuntime });
    }

    const delegationResult = await ensureDelegationProjectRuntime({
      targetDir,
      builtRuntime: delegationBuiltRuntime,
      dryRun,
    });
    const installedProvider = providerResult ?? await installCodexProjectRuntime({
      targetDir,
      builtRuntime: providerBuiltRuntime,
    });
    return composedRuntimeResult("codex", installedProvider, delegationResult);
  });
}

async function uninstallCodexWithDelegation({ targetDir, dryRun }) {
  // Complete the validation of *both* runtime images before changing either one.
  // The manager compares installed bytes against their recorded image hashes,
  // refuses active Work Leases, and preserves evidence/backup directories.
  const codexPlan = await uninstallCodexProjectRuntime({ targetDir, dryRun: true });
  const delegationPlan = await uninstallDelegationProjectRuntime({ targetDir, dryRun: true });
  if (dryRun) {
    return {
      operation: "uninstall", changed: codexPlan.changed || delegationPlan.changed,
      dryRun: true, targetDir: resolve(targetDir),
      codex: codexPlan, delegation: delegationPlan,
    };
  }
  const codex = await uninstallCodexProjectRuntime({ targetDir });
  const delegation = await uninstallDelegationProjectRuntime({ targetDir });
  return {
    operation: "uninstall", changed: codex.changed || delegation.changed,
    targetDir: resolve(targetDir), codex, delegation,
    statePreserved: true,
  };
}

async function updateCodexWithDelegation({ targetDir, dryRun, force }) {
  return withBuiltCodexAndDelegationRuntimes(async ({ providerBuiltRuntime, delegationBuiltRuntime }) => {
    const delegationResult = await ensureDelegationProjectRuntime({
      targetDir,
      builtRuntime: delegationBuiltRuntime,
      dryRun,
    });
    const providerResult = await updateCodexProjectRuntime({
      targetDir,
      builtRuntime: providerBuiltRuntime,
      dryRun,
      force,
    });
    return composedRuntimeResult("codex", providerResult, delegationResult);
  });
}

async function doctorCodexWithDelegation({ targetDir }) {
  return withBuiltCodexAndDelegationRuntimes(async ({ providerBuiltRuntime, delegationBuiltRuntime }) => {
    const providerResult = await doctorCodexProjectRuntime({ targetDir, builtRuntime: providerBuiltRuntime });
    const delegationResult = await doctorDelegationProjectRuntime({ targetDir, builtRuntime: delegationBuiltRuntime });
    return composedDoctorResult(providerResult, delegationResult);
  });
}

async function listCodexRuntimeBackups(targetDir) {
  const root = join(resolve(targetDir), ".orchestra", "state", "runtime-management", "codex", "backups");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const backups = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let metadata = {};
    try {
      metadata = JSON.parse(await readFile(join(root, entry.name, "backup.json"), "utf8"));
    } catch {
      // Preserve visibility of malformed backup directories without trusting their metadata.
    }
    backups.push({
      backupId: entry.name,
      createdAt: metadata.createdAt || null,
      reason: metadata.reason || null,
      runtimeHash: metadata.runtimeHash || null,
    });
  }
  return backups.sort((a, b) => b.backupId.localeCompare(a.backupId));
}

async function run(args) {
  const pos = positional(args);
  const command = pos[0];
  const targetDir = pos[1];
  const json = flag(args, "--json");
  const dryRun = flag(args, "--dry-run");
  const force = flag(args, "--force");

  if (!command || !targetDir) {
    console.error("Usage: orchestra-codex-project <install|update|uninstall|doctor|version|diff-runtime|backups|evidence|rollback> <project> [--dry-run] [--force] [--json]");
    return 2;
  }

  let result;
  switch (command) {
    case "install":
      result = await installCodexWithDelegation({ targetDir, dryRun });
      break;
    case "update":
      result = await updateCodexWithDelegation({ targetDir, dryRun, force });
      break;
    case "uninstall":
      result = await uninstallCodexWithDelegation({ targetDir, dryRun });
      break;
    case "doctor":
      result = await doctorCodexWithDelegation({ targetDir });
      break;
    case "version":
      result = await withBuiltCodexRuntime(async (builtRuntime) => {
        const inspection = await inspectCodexProjectRuntime({ targetDir, builtRuntime });
        return {
          installed: inspection.installed,
          managed: inspection.managed,
          runtime: "CODEX",
          targetDir: resolve(targetDir),
          orchestraVersion: inspection.metadata?.version || null,
          version: inspection.metadata?.version || null,
          manifestHash: inspection.metadata?.manifestHash || null,
          runtimeHash: inspection.metadata?.runtimeHash || null,
          currentRuntimeHash: inspection.targetHash,
          metadataCurrent: inspection.metadataCurrent,
          drifted: inspection.installed && !inspection.clean,
          lastOperation: inspection.metadata?.lastOperation || null,
          previousBackupId: inspection.metadata?.previousBackupId || null,
        };
      });
      break;
    case "diff-runtime":
      result = await withBuiltCodexRuntime(async (builtRuntime) => {
        const inspection = await inspectCodexProjectRuntime({ targetDir, builtRuntime });
        return {
          targetDir: resolve(targetDir),
          clean: inspection.clean,
          metadataCurrent: inspection.metadataCurrent,
          sourceHash: inspection.sourceHash,
          targetHash: inspection.targetHash,
          ...inspection.diff,
        };
      });
      break;
    case "backups":
      result = await listCodexRuntimeBackups(targetDir);
      break;
    case "evidence":
      result = inspectProjectEvidence(targetDir);
      break;
    case "rollback": {
      const idx = args.indexOf("--backup");
      let backupId = idx >= 0 ? args[idx + 1] : "latest";
      if (!backupId || backupId === "latest") {
        const backups = await listCodexRuntimeBackups(targetDir);
        if (!backups[0]) throw new Error("NO_CODEX_RUNTIME_BACKUPS");
        backupId = backups[0].backupId;
      }
      if (dryRun) {
        result = { operation: "rollback", dryRun: true, targetDir: resolve(targetDir), backupId };
      } else {
        result = await rollbackCodexProjectRuntime({ targetDir, backupId, force });
      }
      break;
    }
    default:
      console.error("Unknown command: " + command);
      return 2;
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result?.healthy === false ? 1 : 0;
  }

  if (command === "doctor") {
    console.log("==================================================");
    console.log(" Orchestra Codex Project Doctor");
    console.log("==================================================");
    console.log("Target:               " + result.targetDir);
    console.log("Status:               " + result.status);
    console.log("Version:              " + (result.metadata?.version || "unmanaged"));
    console.log("");
    for (const check of result.checks) console.log(" [" + (check.ok ? "PASS" : "FAIL") + "] " + check.id + " — " + check.detail);
    console.log(" [UNVERIFIED] CODEX_HOOK_ACTIVATION — " + result.hookActivation.instructions);
    return result.healthy ? 0 : 1;
  }

  if (command === "version") {
    console.log("Installed:            " + (result.installed ? "yes" : "no"));
    console.log("Managed:              " + (result.managed ? "yes" : "no"));
    console.log("Runtime:              CODEX");
    console.log("Version:              " + (result.orchestraVersion || "unknown"));
    console.log("Runtime drift:        " + (result.drifted ? "yes" : "no"));
    return 0;
  }

  if (command === "diff-runtime") {
    console.log("Target:               " + result.targetDir);
    console.log("Clean:                " + (result.clean ? "yes" : "no"));
    console.log("Metadata current:     " + (result.metadataCurrent ? "yes" : "no"));
    printDiff(result);
    return result.clean ? 0 : 1;
  }

  if (command === "backups") {
    for (const item of result) console.log(item.backupId + " " + (item.reason || ""));
    return 0;
  }

  if (command === "evidence") {
    console.log(formatEvidenceInspection(result));
    return result.available === false && result.status !== "NO_ACTIVE_STATE" ? 1 : 0;
  }

  if (command === "update" && result.dryRun) {
    console.log("Codex update dry-run:");
    console.log("Target:               " + resolve(targetDir));
    console.log("Operation:            " + result.operation);
    if (result.inspection?.diff) printDiff(result.inspection.diff);
    return 0;
  }

  if (command === "install" && result.dryRun) {
    console.log("Codex install dry-run:");
    console.log("Target:               " + result.targetDir);
    console.log("Would change:         " + (result.changed ? "yes" : "no"));
    return 0;
  }

  console.log("Orchestra Codex runtime " + (command === "rollback" ? "rolled back" : command === "uninstall" ? "uninstalled" : (result.changed === false ? "already up to date" : "updated")) + ".");
  console.log("Target:               " + resolve(targetDir));
  const meta = result.metadata || {};
  if (meta.version) console.log("Version:              " + meta.version);
  if (result.backupId) console.log("Backup:               " + result.backupId);
  if (command === "uninstall" && result.codex?.backupId) console.log("Codex backup:         " + result.codex.backupId);
  if (command === "uninstall" && result.delegation?.backupId) console.log("Delegation backup:    " + result.delegation.backupId);
  return 0;
}

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  console.error(String(error?.message || error));
  process.exitCode = 2;
}
