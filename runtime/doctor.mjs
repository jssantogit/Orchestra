#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { inspectDelegationCapabilities } from "./delegation/discovery.mjs";
import { listDelegationArtifacts } from "./delegation/artifact-store.mjs";
import { listDelegationRecords } from "./delegation/store.mjs";

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL_RUNTIMES = Object.freeze(["core", "codex", "antigravity", "delegation"]);

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

function unavailableDelegationReport() {
  return {
    status: "UNAVAILABLE",
    gitWorktree: { available: false },
    providers: [],
  };
}

function delegationRecovery(repoRoot) {
  try {
    const records = listDelegationRecords(repoRoot);
    const artifacts = listDelegationArtifacts(repoRoot);
    const cleanupFailures = records
      .filter((record) => record.status === "CLEANUP_FAILED")
      .map((record) => ({
        delegationId: record.delegationId,
        recoverablePath: record.workspace.recoverablePath,
      }));
    const inFlight = records
      .filter((record) => record.status === "STARTED")
      .map((record) => ({ delegationId: record.delegationId, startedAt: record.startedAt }));
    const retainedArtifacts = artifacts
      .filter((artifact) => artifact.state === "READY_FOR_REVIEW")
      .map((artifact) => ({
        artifactId: artifact.artifactId,
        state: artifact.state,
        reviewPath: artifact.delegatedPath,
      }));
    return {
      stateReadable: true,
      required: cleanupFailures.length > 0,
      cleanupFailures,
      inFlight,
      retainedArtifacts,
      reason: cleanupFailures.length > 0 ? "WORKSPACE_CLEANUP_FAILED" : null,
    };
  } catch {
    return {
      stateReadable: false,
      required: true,
      cleanupFailures: [],
      inFlight: [],
      retainedArtifacts: [],
      reason: "DELEGATION_STATE_UNREADABLE",
    };
  }
}

export async function runDoctor({
  repoRoot = moduleRoot,
  runtime = "all",
  runCommands = true,
  commandRunner = commandCheck,
  delegationInspector = inspectDelegationCapabilities,
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

  let delegation = null;
  if (root === moduleRoot || delegationInspector !== inspectDelegationCapabilities) {
    try {
      delegation = await delegationInspector();
    } catch {
      delegation = unavailableDelegationReport();
    }
    delegation = {
      ...delegation,
      recovery: delegationRecovery(root),
    };
  }

  return {
    healthy: checks.length > 0 && checks.every((item) => item.ok),
    runtime,
    checks,
    delegation,
  };
}

async function main() {
  const runtimeArg = process.argv.find((arg) => arg.startsWith("--runtime="));
  const runtime = runtimeArg ? runtimeArg.slice("--runtime=".length) : "all";
  const report = await runDoctor({ runtime });
  for (const item of report.checks) {
    console.log(`${item.ok ? "PASS" : "FAIL"} ${item.id}${item.detail ? ` — ${item.detail}` : ""}`);
  }
  if (report.delegation) {
    const providerSummary = report.delegation.providers
      .map((provider) => `${provider.provider}=${provider.available ? "available" : "unavailable"}`)
      .join(", ");
    console.log(`INFO delegation:readiness — ${report.delegation.status}; gitWorktree=${report.delegation.gitWorktree.available ? "available" : "unavailable"}${providerSummary ? `; ${providerSummary}` : ""}`);
    if (report.delegation.recovery?.required) {
      const recovery = report.delegation.recovery;
      const paths = recovery.cleanupFailures.map((entry) => entry.recoverablePath).filter(Boolean);
      console.log(`INFO delegation:recovery — ${recovery.reason || "RECOVERY_REQUIRED"}${paths.length ? `; paths=${paths.join(",")}` : ""}`);
    }
    if (report.delegation.recovery?.retainedArtifacts?.length > 0) {
      const retained = report.delegation.recovery.retainedArtifacts
        .map((entry) => entry.artifactId)
        .join(",");
      console.log(`INFO delegation:retained-artifacts — ${retained}`);
    }
  }
  console.log(report.healthy ? "Orchestra Doctor: healthy" : "Orchestra Doctor: unhealthy");
  if (!report.healthy) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
