#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  inspectCodexProjectRuntime,
  installCodexProjectRuntime,
} from "../providers/codex/project-runtime-manager.mjs";
import { ensureDelegationProjectRuntime } from "../runtime/delegation/project-runtime-manager.mjs";
import { buildRuntime } from "../runtime/runtime-builder.mjs";

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: node install-codex.mjs <target-project-path>");
  process.exit(1);
}

const targetDir = resolve(args[0]);
if (!existsSync(targetDir)) {
  console.error(`Error: Target directory '${targetDir}' does not exist.`);
  process.exit(1);
}

function installConflict(paths = []) {
  const error = new Error(`RUNTIME_INSTALL_CONFLICT: ${paths.join(", ") || "codex runtime already installed"}`);
  error.code = "RUNTIME_INSTALL_CONFLICT";
  error.paths = paths;
  return error;
}

let buildRoot;
try {
  console.log(`Installing Orchestra Codex runtime into '${targetDir}'...`);
  buildRoot = await mkdtemp(join(tmpdir(), "orchestra-codex-install-"));
  const builtRuntime = join(buildRoot, "codex");
  const delegationBuiltRuntime = join(buildRoot, "delegation");
  await buildRuntime({ runtime: "codex", outputDir: builtRuntime });
  await buildRuntime({ runtime: "delegation", outputDir: delegationBuiltRuntime });

  const inspection = await inspectCodexProjectRuntime({ targetDir, builtRuntime });
  if (inspection.installed) {
    throw installConflict([
      ...inspection.diff.removed,
      ...inspection.diff.changed,
      ...inspection.diff.unchanged,
    ]);
  }

  const delegationResult = await ensureDelegationProjectRuntime({
    targetDir,
    builtRuntime: delegationBuiltRuntime,
  });
  const result = await installCodexProjectRuntime({ targetDir, builtRuntime });
  console.log(`Codex runtime successfully installed to '${targetDir}/.codex'.`);
  console.log(`Delegation runtime: ${delegationResult.operation}.`);
  console.log(`Version: ${result.metadata.version || "unknown"}`);
  console.log("Verify with: node scripts/orchestra-codex-project.mjs doctor <project>");
} catch (error) {
  if (error?.code === "RUNTIME_INSTALL_CONFLICT" || /RUNTIME_INSTALL_CONFLICT/.test(String(error?.message || ""))) {
    console.error(`Conflict detected: managed Codex runtime paths already exist in '${targetDir}'.`);
    console.error("Aborting installation to prevent overwriting existing configuration.");
    console.error("Use orchestra-codex-project.mjs update to adopt/update an existing runtime.");
    process.exitCode = 2;
  } else {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
} finally {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
}
