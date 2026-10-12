#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL_RUNTIMES = Object.freeze(["core", "codex", "antigravity"]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function check(id, ok, detail) {
  return { id, ok: Boolean(ok), detail: String(detail ?? "") };
}

function isCovered(path, roots) {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function commandCheck(repoRoot, id, command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CI: process.env.CI || "1" },
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  return check(id, result.status === 0, output || `exit=${result.status}`);
}

function manifestNames(repoRoot, runtime) {
  if (runtime !== "all") return [runtime];
  return CANONICAL_RUNTIMES.filter((name) => existsSync(join(repoRoot, "runtime", "manifests", `${name}.json`)));
}

export async function runDoctor({
  repoRoot = moduleRoot,
  runtime = "all",
  runCommands = true,
  commandRunner = commandCheck,
} = {}) {
  const root = resolve(repoRoot);
  const checks = [];
  let packageJson = null;
  try {
    packageJson = readJson(join(root, "package.json"));
    checks.push(check("package:metadata", typeof packageJson.version === "string" && packageJson.version.length > 0, packageJson.version || "missing version"));
  } catch (error) {
    checks.push(check("package:metadata", false, error.message));
  }

  const names = manifestNames(root, runtime);
  if (names.length === 0) checks.push(check("runtime:selection", false, `no manifests selected for ${runtime}`));

  for (const name of names) {
    const path = join(root, "runtime", "manifests", `${name}.json`);
    let manifest;
    try {
      manifest = readJson(path);
      const basic = manifest?.schema === "orchestra.runtime-manifest.v1"
        && manifest?.runtime === name
        && Array.isArray(manifest?.sourceRoots)
        && Array.isArray(manifest?.managedAssets)
        && Array.isArray(manifest?.preservedProjectPaths)
        && Array.isArray(manifest?.generatedInputs)
        && Array.isArray(manifest?.entrypoints);
      checks.push(check(`${name}:manifest`, basic, basic ? "valid manifest shape" : "invalid manifest shape"));
    } catch (error) {
      checks.push(check(`${name}:manifest`, false, error.message));
      continue;
    }

    checks.push(check(
      `${name}:version-coherence`,
      Boolean(packageJson?.version) && manifest.version === packageJson.version,
      `package=${packageJson?.version || "missing"}; manifest=${manifest.version || "missing"}`,
    ));

    const missing = manifest.managedAssets
      .map((asset) => asset?.source)
      .filter((source) => typeof source !== "string" || !existsSync(join(root, source)));
    checks.push(check(
      `${name}:managed-assets`,
      missing.length === 0,
      missing.length === 0 ? `${manifest.managedAssets.length} sources present` : `missing: ${missing.join(", ")}`,
    ));

    const outputs = manifest.managedAssets.map((asset) => asset?.output).filter(Boolean);
    const uncovered = manifest.entrypoints.filter((entrypoint) => !isCovered(entrypoint, outputs));
    checks.push(check(
      `${name}:entrypoints`,
      uncovered.length === 0,
      uncovered.length === 0 ? `${manifest.entrypoints.length} entrypoints covered` : `uncovered: ${uncovered.join(", ")}`,
    ));
  }

  if (runCommands && (root === moduleRoot || commandRunner !== commandCheck)) {
    checks.push(commandRunner(root, "generated:schemas", process.execPath, ["scripts/build-schema-validators.mjs", "--check"]));
    checks.push(commandRunner(root, "runtime:builder-contract", process.execPath, ["--test", "tests/runtime/runtime-builder.test.mjs"]));
    checks.push(commandRunner(root, "runtime:build-freshness", process.execPath, ["scripts/check-runtime-build.mjs"]));
    checks.push(commandRunner(root, "architecture:contamination", process.execPath, ["scripts/contamination-check.mjs"]));
    checks.push(commandRunner(root, "architecture:firewall", process.execPath, ["--test", "tests/cross-runtime/cross-runtime-firewall.test.mjs", "tests/cross-runtime/core-provider-firewall.test.mjs"]));
    checks.push(commandRunner(root, "runtime:self-contained", process.execPath, ["--test", "tests/installers/self-contained-runtime.test.mjs"]));
  }

  return {
    healthy: checks.length > 0 && checks.every((item) => item.ok),
    runtime,
    checks,
  };
}

async function main() {
  const runtimeArg = process.argv.find((arg) => arg.startsWith("--runtime="));
  const runtime = runtimeArg ? runtimeArg.slice("--runtime=".length) : "all";
  const report = await runDoctor({ runtime });
  for (const item of report.checks) {
    console.log(`${item.ok ? "PASS" : "FAIL"} ${item.id}${item.detail ? ` — ${item.detail}` : ""}`);
  }
  console.log(report.healthy ? "Orchestra Doctor: healthy" : "Orchestra Doctor: unhealthy");
  if (!report.healthy) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
