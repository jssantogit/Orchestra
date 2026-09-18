#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runProjectRuntimeCli } from "../runtimes/antigravity/.agents/skills/orchestra/project-runtime-cli.mjs";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const orchestraRoot = resolve(scriptDir, "..");
const sourceRuntimeRoot = resolve(orchestraRoot, "runtimes", "antigravity");

try {
  const code = await runProjectRuntimeCli(process.argv.slice(2), {
    defaultSourceRuntimeRoot: sourceRuntimeRoot,
  });
  process.exitCode = code;
} catch (error) {
  console.error(String(error?.message || error));
  process.exitCode = 2;
}
