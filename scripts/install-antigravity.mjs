#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  installProjectRuntime,
} from "../runtimes/antigravity/.agents/skills/orchestra/project-runtime-manager.mjs";

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: node install-antigravity.mjs <target-project-path>");
  process.exit(1);
}

const targetDir = resolve(args[0]);
const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const orchestraRoot = resolve(scriptDir, "..");
const sourceRuntimeRoot = resolve(orchestraRoot, "runtimes", "antigravity");

try {
  console.log("Installing Orchestra Antigravity runtime into '" + targetDir + "'...");
  const result = installProjectRuntime({
    sourceRuntimeRoot,
    targetDir,
  });

  console.log("Antigravity runtime successfully installed to '" + resolve(targetDir, ".agents") + "'.");
  console.log("Runtime metadata: " + resolve(targetDir, ".agents", "orchestra-runtime.json"));
  console.log("Source commit: " + (result.metadata?.sourceCommit || "unknown"));
  console.log(
    "Verify installation by running: node --test "
    + resolve(targetDir, ".agents", "skills", "orchestra", "routing-policy.test.mjs")
  );
} catch (error) {
  if (error?.code === "INSTALL_CONFLICT") {
    console.error(
      "Conflict detected: '" + resolve(targetDir, ".agents")
      + "' or '" + resolve(targetDir, "GEMINI.md")
      + "' already exists in target project."
    );
    console.error("Aborting installation to prevent destructive overwriting.");
    console.error(
      "Use the updater instead: node scripts/orchestra-project.mjs update "
      + JSON.stringify(targetDir)
    );
    process.exit(2);
  }

  console.error(String(error?.message || error));
  process.exit(1);
}
