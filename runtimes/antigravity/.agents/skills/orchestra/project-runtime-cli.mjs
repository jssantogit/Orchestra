#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  diffProjectRuntime,
  doctorProjectRuntime,
  getProjectRuntimeVersion,
  installProjectRuntime,
  listRuntimeBackups,
  rollbackProjectRuntime,
  updateProjectRuntime,
} from "./project-runtime-manager.mjs";
import {
  formatEvidenceInspection,
  inspectProjectEvidence,
} from "./evidence-inspector.mjs";

function parseArgs(argv) {
  const positional = [];
  const flags = {
    dryRun: false,
    force: false,
    json: false,
    source: null,
    backup: "latest",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--source") flags.source = argv[++i] || null;
    else if (arg === "--backup") flags.backup = argv[++i] || "latest";
    else positional.push(arg);
  }

  return { positional, flags };
}

function usage() {
  return [
    "Orchestra Project Runtime Manager",
    "",
    "Usage:",
    "  orchestra-project install <target> [--dry-run]",
    "  orchestra-project update <target> [--dry-run] [--force] [--source <runtime-root>]",
    "  orchestra-project doctor <target> [--source <runtime-root>] [--json]",
    "  orchestra-project version <target> [--json]",
    "  orchestra-project diff-runtime <target> [--source <runtime-root>] [--json]",
    "  orchestra-project rollback-runtime <target> [--backup <id|latest>] [--dry-run] [--force]",
    "  orchestra-project backups <target> [--json]",
    "  orchestra-project evidence <target> [--json]",
    "",
    "Installed-project shortcuts:",
    "  node .agents/skills/orchestra/project-runtime-cli.mjs doctor",
    "  node .agents/skills/orchestra/project-runtime-cli.mjs version",
    "  node .agents/skills/orchestra/project-runtime-cli.mjs backups",
    "  node .agents/skills/orchestra/project-runtime-cli.mjs evidence",
    "",
    "Update/diff require an Orchestra source runtime. The source-repo wrapper",
    "scripts/orchestra-project.mjs supplies it automatically.",
  ].join("\n");
}

function line(label, value) {
  return label.padEnd(22) + String(value);
}

function printDiff(diff) {
  console.log(line("Added / missing:", diff.summary.added));
  console.log(line("Removed / stale:", diff.summary.removed));
  console.log(line("Changed:", diff.summary.changed));
  console.log(line("Unchanged:", diff.summary.unchanged));

  const groups = [
    ["ADD", diff.added],
    ["REMOVE", diff.removed],
    ["CHANGE", diff.changed],
  ];
  for (const [label, paths] of groups) {
    for (const path of paths.slice(0, 80)) {
      console.log("  " + label.padEnd(7) + path);
    }
    if (paths.length > 80) {
      console.log("  ... " + (paths.length - 80) + " more");
    }
  }
}

function printDoctor(result) {
  console.log("==================================================");
  console.log(" Orchestra Project Doctor");
  console.log("==================================================");
  console.log(line("Target:", result.targetDir));
  console.log(line("Status:", result.status));

  if (result.metadata) {
    console.log(line("Version:", result.metadata.orchestraVersion || "unknown"));
    console.log(line("Source commit:", result.metadata.sourceCommit || "unknown"));
    console.log(line("Installed at:", result.metadata.installedAt || "unknown"));
    console.log(line("Updated at:", result.metadata.updatedAt || "unknown"));
  }

  console.log(line("Runtime state:", result.quiescence?.reason || "unknown"));
  console.log("");

  for (const check of result.checks) {
    console.log(" [" + (check.ok ? "PASS" : "FAIL") + "] " + check.id + " — " + check.detail);
  }

  if (result.sourceComparison) {
    console.log("");
    console.log(line("Current source:", result.sourceComparison.sourceCommit || "unknown"));
    console.log(line("Up to date:", result.sourceComparison.upToDate ? "yes" : "no"));
  }

  console.log("");
  console.log("Preserved project-owned paths:");
  for (const item of result.preservedProjectPaths || []) {
    console.log("  " + (item.exists ? "[present] " : "[absent]  ") + item.path);
  }

  if (result.backups?.length) {
    console.log("");
    console.log("Runtime backups: " + result.backups.length);
    console.log("Latest backup: " + result.backups[0].backupId);
  }
}

function printVersion(result) {
  console.log(line("Installed:", result.installed ? "yes" : "no"));
  console.log(line("Managed:", result.managed ? "yes" : "legacy/unmanaged"));
  console.log(line("Version:", result.orchestraVersion || "unknown"));
  console.log(line("Source commit:", result.sourceCommit || "unknown"));
  console.log(line("Source branch:", result.sourceBranch || "unknown"));
  console.log(line("Installed at:", result.installedAt || "unknown"));
  console.log(line("Updated at:", result.updatedAt || "unknown"));
  console.log(line("Last operation:", result.lastOperation || "unknown"));
  console.log(line("Runtime drift:", result.drifted ? "YES" : "no"));
  console.log(line("Manifest:", result.currentManifestHash));
}

function sourceOrThrow(flags, defaultSourceRuntimeRoot) {
  const source = flags.source || defaultSourceRuntimeRoot;
  if (!source) {
    const error = new Error(
      "SOURCE_REQUIRED: use --source <Orchestra/runtimes/antigravity> or run via scripts/orchestra-project.mjs"
    );
    error.code = "SOURCE_REQUIRED";
    throw error;
  }
  return resolve(source);
}

function defaultInstalledTarget() {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return resolve(here, "..", "..", "..");
}

export async function runProjectRuntimeCli(argv = process.argv.slice(2), {
  defaultSourceRuntimeRoot = null,
  defaultTargetDir = null,
} = {}) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];

  if (!command || command === "--help" || command === "help") {
    console.log(usage());
    return 0;
  }

  const target = resolve(
    positional[1]
      || defaultTargetDir
      || defaultInstalledTarget()
  );

  let result;

  switch (command) {
    case "install": {
      const source = sourceOrThrow(flags, defaultSourceRuntimeRoot);
      result = installProjectRuntime({
        sourceRuntimeRoot: source,
        targetDir: target,
        dryRun: flags.dryRun,
      });
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log((flags.dryRun ? "Would install" : "Installed") + " Orchestra Antigravity runtime.");
        console.log(line("Target:", target));
        console.log(line("Version:", result.metadata?.orchestraVersion || result.orchestraVersion || "unknown"));
        console.log(line("Source commit:", result.metadata?.sourceCommit || result.sourceCommit || "unknown"));
      }
      return 0;
    }

    case "update": {
      const source = sourceOrThrow(flags, defaultSourceRuntimeRoot);
      result = updateProjectRuntime({
        sourceRuntimeRoot: source,
        targetDir: target,
        dryRun: flags.dryRun,
        force: flags.force,
      });
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else if (flags.dryRun) {
        console.log("Update dry-run:");
        console.log(line("Target:", target));
        console.log(line("Runtime state:", result.quiescence?.reason || "unknown"));
        printDiff(result.diff);
      } else if (result.changed === false) {
        console.log("Orchestra runtime already matches source.");
        console.log(line("Target:", target));
        console.log(line("Source commit:", result.metadata?.sourceCommit || "unknown"));
      } else {
        console.log("Orchestra runtime updated successfully.");
        console.log(line("Target:", target));
        console.log(line("Version:", result.metadata?.orchestraVersion || "unknown"));
        console.log(line("Source commit:", result.metadata?.sourceCommit || "unknown"));
        console.log(line("Backup:", result.backup?.backupId || "none"));
        printDiff(result.diff);
      }
      return 0;
    }

    case "doctor": {
      result = doctorProjectRuntime({
        targetDir: target,
        sourceRuntimeRoot: flags.source || defaultSourceRuntimeRoot || null,
      });
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else printDoctor(result);
      return result.healthy ? 0 : 1;
    }

    case "version": {
      result = getProjectRuntimeVersion(target);
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else printVersion(result);
      return result.installed ? 0 : 1;
    }

    case "diff-runtime":
    case "diff": {
      const source = sourceOrThrow(flags, defaultSourceRuntimeRoot);
      result = diffProjectRuntime({
        sourceRuntimeRoot: source,
        targetDir: target,
      });
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(line("Target:", target));
        console.log(line("Source commit:", result.sourceCommit || "unknown"));
        console.log(line("Clean:", result.clean ? "yes" : "no"));
        printDiff(result);
      }
      return 0;
    }

    case "rollback-runtime":
    case "rollback": {
      result = rollbackProjectRuntime({
        targetDir: target,
        backupId: flags.backup,
        dryRun: flags.dryRun,
        force: flags.force,
      });
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else if (flags.dryRun) {
        console.log("Rollback dry-run:");
        console.log(line("Target:", target));
        console.log(line("Backup:", result.selectedBackup.backupId));
      } else {
        console.log("Orchestra runtime rollback completed.");
        console.log(line("Target:", target));
        console.log(line("Restored backup:", result.restoredBackup.backupId));
        console.log(line("Safety backup:", result.safetyBackup.backupId));
      }
      return 0;
    }

    case "evidence":
    case "evidence-status": {
      result = inspectProjectEvidence(target);
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else console.log(formatEvidenceInspection(result));
      return result.available ? 0 : 1;
    }

    case "backups": {
      result = listRuntimeBackups(target);
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else if (result.length === 0) {
        console.log("No Orchestra runtime backups.");
      } else {
        for (const item of result) {
          console.log(
            item.backupId
            + "  " + (item.reason || "unknown")
            + "  " + (item.manifestHash || "unknown")
          );
        }
      }
      return 0;
    }

    default:
      console.error("Unknown command: " + command);
      console.error("");
      console.error(usage());
      return 2;
  }
}

async function main() {
  try {
    const code = await runProjectRuntimeCli();
    process.exitCode = code;
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 2;
  }
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invoked === import.meta.url) {
  await main();
}
