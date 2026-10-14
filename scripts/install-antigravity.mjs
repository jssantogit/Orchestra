#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  inspectAntigravityProjectRuntime,
  installAntigravityProjectRuntime,
} from "../providers/antigravity/project-runtime-manager.mjs";
import { ensureDelegationProjectRuntime } from "../runtime/delegation/project-runtime-manager.mjs";
import { buildRuntime } from "../runtime/runtime-builder.mjs";

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: node install-antigravity.mjs <target-project-path>");
  process.exit(1);
}

const targetDir = resolve(args[0]);
if (!existsSync(targetDir)) {
  console.error(`Error: Target directory '${targetDir}' does not exist.`);
  process.exit(1);
}

let buildRoot;
try {
  console.log(`Installing Orchestra Antigravity runtime into '${targetDir}'...`);
  buildRoot = await mkdtemp(join(tmpdir(), "orchestra-antigravity-install-"));
  const builtRuntime = join(buildRoot, "antigravity");
  const delegationBuiltRuntime = join(buildRoot, "delegation");
  await buildRuntime({ runtime: "antigravity", outputDir: builtRuntime });
  await buildRuntime({ runtime: "delegation", outputDir: delegationBuiltRuntime });

  const inspection = await inspectAntigravityProjectRuntime({ targetDir, builtRuntime });
  if (inspection.installed) {
    await installAntigravityProjectRuntime({ targetDir, builtRuntime });
  }

  const delegationResult = await ensureDelegationProjectRuntime({
    targetDir,
    builtRuntime: delegationBuiltRuntime,
  });
  const result = await installAntigravityProjectRuntime({ targetDir, builtRuntime });

  console.log(`Antigravity runtime successfully installed to '${resolve(targetDir, ".agents")}'.`);
  console.log(`Delegation runtime: ${delegationResult.operation}.`);
  console.log(`Version: ${result.metadata.version || "unknown"}`);
  console.log(`Verify with: node scripts/orchestra-project.mjs doctor ${JSON.stringify(targetDir)}`);
} catch (error) {
  if (error?.code === "RUNTIME_INSTALL_CONFLICT" || /RUNTIME_INSTALL_CONFLICT/.test(String(error?.message || ""))) {
    console.error(`Conflict detected: managed Antigravity runtime paths already exist in '${targetDir}'.`);
    console.error("Aborting installation to prevent destructive overwriting.");
    console.error(`Use the updater instead: node scripts/orchestra-project.mjs update ${JSON.stringify(targetDir)}`);
    process.exitCode = 2;
  } else {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
} finally {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
}
