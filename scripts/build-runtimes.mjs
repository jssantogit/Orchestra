#!/usr/bin/env node

import { resolve } from "node:path";

import { buildRuntime, runtimeRepositoryRoot } from "../runtime/runtime-builder.mjs";

const repoRoot = runtimeRepositoryRoot();
const runtimes = ["codex", "antigravity"];

for (const runtime of runtimes) {
  const outputDir = resolve(repoRoot, "dist", "runtime", runtime);
  const result = await buildRuntime({ runtime, outputDir });
  console.log(`${runtime}: ${result.files.length} files (${result.manifestHash})`);
}
