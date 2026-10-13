#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildRuntime, runtimeRepositoryRoot, verifyBuiltRuntime } from "../runtime/runtime-builder.mjs";

const repoRoot = runtimeRepositoryRoot();
const runtimes = ["codex", "antigravity", "delegation"];
const tempRoot = await mkdtemp(join(tmpdir(), "orchestra-runtime-check-"));

try {
  for (const runtime of runtimes) {
    const distDir = resolve(repoRoot, "dist", "runtime", runtime);
    const freshDir = join(tempRoot, runtime);
    const fresh = await buildRuntime({ runtime, outputDir: freshDir });
    const dist = await verifyBuiltRuntime({ runtime, outputDir: distDir });
    assert.deepEqual(dist, fresh, `${runtime} distribution is stale or non-deterministic`);
    const diskMetadata = JSON.parse(await readFile(join(distDir, "orchestra-runtime-build.json"), "utf8"));
    assert.deepEqual(diskMetadata, fresh, `${runtime} build metadata drifted`);
    console.log(`${runtime}: deterministic runtime distribution verified`);
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
