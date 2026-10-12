import { inspectProjectEvidence, formatEvidenceInspection } from "./evidence-inspector.mjs";
import {
  diffCodexProjectRuntime,
  doctorCodexProjectRuntime,
  getCodexProjectRuntimeVersion,
  installCodexProjectRuntime,
  listCodexRuntimeBackups,
  rollbackCodexProjectRuntime,
  updateCodexProjectRuntime,
} from "./codex-runtime-manager.mjs";

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

export async function runCodexProjectRuntimeCli(args, { defaultSourceRuntimeRoot } = {}) {
  const pos = positional(args);
  const command = pos[0];
  const targetDir = pos[1];
  const json = flag(args, "--json");
  const dryRun = flag(args, "--dry-run");
  const force = flag(args, "--force");

  if (!command || !targetDir) {
    console.error("Usage: orchestra-codex-project <install|update|doctor|version|diff-runtime|backups|evidence|rollback> <project> [--dry-run] [--force] [--json]");
    return 2;
  }

  let result;
  switch (command) {
    case "install":
      result = installCodexProjectRuntime({ sourceRuntimeRoot: defaultSourceRuntimeRoot, targetDir, dryRun });
      break;
    case "update":
      result = updateCodexProjectRuntime({ sourceRuntimeRoot: defaultSourceRuntimeRoot, targetDir, dryRun, force });
      break;
    case "doctor":
      result = doctorCodexProjectRuntime({ targetDir, sourceRuntimeRoot: defaultSourceRuntimeRoot });
      break;
    case "version":
      result = getCodexProjectRuntimeVersion(targetDir);
      break;
    case "diff-runtime":
      result = diffCodexProjectRuntime({ sourceRuntimeRoot: defaultSourceRuntimeRoot, targetDir });
      break;
    case "backups":
      result = listCodexRuntimeBackups(targetDir);
      break;
    case "evidence":
      result = inspectProjectEvidence(targetDir);
      break;
    case "rollback": {
      const idx = args.indexOf("--backup");
      const backupId = idx >= 0 ? args[idx + 1] : "latest";
      result = rollbackCodexProjectRuntime({ targetDir, backupId, dryRun, force });
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
    console.log("Version:              " + (result.metadata?.orchestraVersion || "unmanaged"));
    console.log("Source commit:        " + (result.metadata?.sourceCommit || "unknown"));
    console.log("Runtime state:        " + result.quiescence.reason);
    console.log("");
    for (const check of result.checks) console.log(" [" + (check.ok ? "PASS" : "FAIL") + "] " + check.id + " — " + check.detail);
    console.log("");
    console.log("Preserved project-owned paths:");
    for (const item of result.preservedProjectPaths) console.log("  [" + (item.exists ? "present" : "absent") + "] " + item.path);
    console.log("");
    console.log("Runtime backups: " + result.backups.length);
    if (result.backups[0]) console.log("Latest backup: " + result.backups[0].backupId);
    return result.healthy ? 0 : 1;
  }

  if (command === "version") {
    console.log("Installed:            " + (result.installed ? "yes" : "no"));
    console.log("Managed:              " + (result.managed ? "yes" : "no"));
    console.log("Runtime:              CODEX");
    console.log("Version:              " + (result.orchestraVersion || "unknown"));
    console.log("Source commit:        " + (result.sourceCommit || "unknown"));
    console.log("Source branch:        " + (result.sourceBranch || "unknown"));
    console.log("Runtime drift:        " + (result.drifted ? "yes" : "no"));
    return 0;
  }

  if (command === "diff-runtime") {
    console.log("Target:               " + result.targetDir);
    console.log("Source commit:        " + (result.sourceCommit || "unknown"));
    console.log("Clean:                " + (result.clean ? "yes" : "no"));
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
    console.log("Target:               " + result.targetDir);
    console.log("Runtime state:        " + result.quiescence.reason);
    console.log("Metadata sync:        " + (result.metadataChanged ? "required" : "no"));
    printDiff(result.diff);
    return 0;
  }

  if (command === "update" && result.operation === "metadata-sync") {
    console.log("Orchestra Codex runtime content already matched; metadata synchronized.");
  } else {
    console.log("Orchestra Codex runtime " + (command === "rollback" ? "rolled back" : (result.changed === false ? "already up to date" : "updated")) + ".");
  }
  console.log("Target:               " + result.targetDir);
  const meta = result.metadata || {};
  if (meta.orchestraVersion) console.log("Version:              " + meta.orchestraVersion);
  if (meta.sourceCommit) console.log("Source commit:        " + meta.sourceCommit);
  if (result.backup?.backupId) console.log("Backup:               " + result.backup.backupId);
  if (result.diff) printDiff(result.diff);
  return 0;
}
