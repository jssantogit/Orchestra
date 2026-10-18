#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateCutoverReleaseEvidence } from "../v2/cutover/release-evidence.mjs";

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIMES = Object.freeze(["core", "codex", "antigravity"]);
const REQUIRED_SCRIPTS = Object.freeze([
  "test",
  "test:runtime",
  "test:core",
  "test:direct-work",
  "test:leases",
  "test:labs",
  "test:installers",
  "test:firewall",
  "test:architecture-invariants",
  "check:schemas",
  "check:runtime-core",
  "build:runtimes",
  "check:runtimes",
  "check:contamination",
  "doctor",
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function check(id, ok, detail = "") {
  return { id, ok: Boolean(ok), detail: String(detail) };
}

function packageGate(root, script) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "--silent", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.error) return { ok: false, detail: result.error.message };
  const output = [result.stderr, result.stdout]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" | ");
  return {
    ok: result.status === 0,
    detail: result.status === 0 ? `${script}: current` : `${script}: exit=${result.status}${output ? `; ${output.slice(-800)}` : ""}`,
  };
}

export function checkReleaseReadiness({
  repoRoot = moduleRoot,
  expectedVersion,
  requireV2Cutover = false,
  cutoverEvidence = null,
  expectedHeadSha = null,
  expectedRuntimeImageId = null,
} = {}) {
  const root = resolve(repoRoot);
  const checks = [];
  let packageJson = null;

  try {
    packageJson = readJson(join(root, "package.json"));
    checks.push(check(
      "version:package",
      packageJson.version === expectedVersion,
      `expected=${expectedVersion}; actual=${packageJson.version || "missing"}`,
    ));
  } catch (error) {
    checks.push(check("version:package", false, error.message));
  }

  try {
    const lock = readJson(join(root, "package-lock.json"));
    const lockVersion = lock?.packages?.[""]?.version ?? lock?.version;
    checks.push(check("version:lock", lockVersion === expectedVersion, `expected=${expectedVersion}; actual=${lockVersion || "missing"}`));
  } catch (error) {
    checks.push(check("version:lock", false, error.message));
  }

  for (const runtime of RUNTIMES) {
    try {
      const manifest = readJson(join(root, "runtime", "manifests", `${runtime}.json`));
      checks.push(check(`version:manifest:${runtime}`, manifest.version === expectedVersion, `expected=${expectedVersion}; actual=${manifest.version || "missing"}`));
    } catch (error) {
      checks.push(check(`version:manifest:${runtime}`, false, error.message));
    }
  }

  if (packageJson?.scripts) {
    const missingScripts = REQUIRED_SCRIPTS.filter((name) => typeof packageJson.scripts[name] !== "string" || packageJson.scripts[name].trim() === "");
    checks.push(check(
      "gates:package-scripts",
      missingScripts.length === 0,
      missingScripts.length === 0 ? "required release gates declared" : `missing: ${missingScripts.join(", ")}`,
    ));
  } else {
    checks.push(check("gates:package-scripts", false, "package.json scripts missing"));
  }

  const schemaValidator = join(root, "core", "schema", "generated", "implementation-packet.v1.mjs");
  const schemaSource = join(root, "schemas", "implementation-packet.v1.schema.json");
  const hasSchemaPair = existsSync(schemaValidator) && existsSync(schemaSource);
  checks.push(check("generated:schema-contract", hasSchemaPair, hasSchemaPair ? "canonical schema + generated validator present" : "missing canonical schema or generated validator"));

  if (typeof packageJson?.scripts?.["check:schemas"] === "string") {
    const result = packageGate(root, "check:schemas");
    checks.push(check("generated:schema-freshness", result.ok, result.detail));
  } else {
    checks.push(check("generated:schema-freshness", false, "check:schemas gate unavailable"));
  }

  if (typeof packageJson?.scripts?.["check:runtimes"] === "string") {
    const result = packageGate(root, "check:runtimes");
    checks.push(check("generated:runtime-freshness", result.ok, result.detail));
  } else {
    checks.push(check("generated:runtime-freshness", false, "check:runtimes gate unavailable"));
  }

  const migrationPath = join(root, "docs", "migrations", "0.10-to-1.x.md");
  if (!existsSync(migrationPath)) {
    checks.push(check("docs:migration", false, "missing docs/migrations/0.10-to-1.x.md"));
  } else {
    const migration = readFileSync(migrationPath, "utf8");
    const required = [
      "ORCHESTRA_DIRECT_WORK_MODE=off|shadow|on",
      "ORCHESTRA_AUTHORITY_MODE=session|dual|lease",
      "rollback",
      "preserv",
    ];
    const missing = required.filter((token) => !migration.toLowerCase().includes(token.toLowerCase()));
    checks.push(check("docs:migration", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : "rollback levers documented"));
  }

  const checklistPath = join(root, "docs", "release", "1.x-checklist.md");
  if (!existsSync(checklistPath)) {
    checks.push(check("docs:release-checklist", false, "missing docs/release/1.x-checklist.md"));
  } else {
    const checklist = readFileSync(checklistPath, "utf8");
    const hasOperatorGate = /operator approval required/i.test(checklist) && /stable version|1\.0\.0/i.test(checklist);
    checks.push(check("docs:release-checklist", hasOperatorGate, hasOperatorGate ? "technical/operator gates separated" : "operator-gated stable release boundary missing"));
  }

  if (requireV2Cutover) {
    if (!cutoverEvidence) {
      checks.push(check("v2:cutover-evidence", false, "required cutover evidence was not supplied"));
    } else {
      try {
        const validation = validateCutoverReleaseEvidence(cutoverEvidence, {
          expectedHeadSha,
          expectedRuntimeImageId,
        });
        checks.push(check(
          "v2:cutover-evidence",
          validation.valid,
          validation.valid ? "exact-head/runtime cutover evidence verified" : `invalid: ${validation.errors.join(", ")}`,
        ));
      } catch (error) {
        checks.push(check("v2:cutover-evidence", false, error.message));
      }
    }
  } else {
    checks.push(check("v2:cutover-evidence", true, "not required by this readiness invocation"));
  }

  const failures = checks.filter((item) => !item.ok);
  return {
    expectedVersion,
    ready: checks.length > 0 && failures.length === 0,
    failures,
    checks,
  };
}

function valueArg(argv, names) {
  const inline = argv.find((value) => names.some((name) => value.startsWith(`${name}=`)));
  if (inline) return inline.slice(inline.indexOf("=") + 1);
  const index = argv.findIndex((value) => names.includes(value));
  return index >= 0 ? argv[index + 1] : null;
}

function versionArg(argv) {
  return valueArg(argv, ["--expected-version", "--version"]);
}

function main() {
  const argv = process.argv.slice(2);
  const expectedVersion = versionArg(argv) || readJson(join(moduleRoot, "package.json")).version;
  const requireV2Cutover = argv.includes("--require-v2-cutover") || process.env.ORCHESTRA_V2_REQUIRE_CUTOVER === "1";
  const cutoverEvidencePath = valueArg(argv, ["--cutover-evidence"])
    || process.env.ORCHESTRA_V2_CUTOVER_EVIDENCE
    || null;
  const expectedHeadSha = valueArg(argv, ["--expected-head"])
    || process.env.ORCHESTRA_V2_EXPECTED_HEAD
    || null;
  const expectedRuntimeImageId = valueArg(argv, ["--expected-runtime-image"])
    || process.env.ORCHESTRA_V2_EXPECTED_RUNTIME_IMAGE
    || null;
  let cutoverEvidence = null;
  if (cutoverEvidencePath) {
    try {
      cutoverEvidence = readJson(resolve(cutoverEvidencePath));
    } catch (error) {
      cutoverEvidence = Object.freeze({ __readError: error.message });
    }
  }

  const report = checkReleaseReadiness({
    expectedVersion,
    requireV2Cutover,
    cutoverEvidence,
    expectedHeadSha,
    expectedRuntimeImageId,
  });
  for (const item of report.checks) {
    console.log(`${item.ok ? "PASS" : "FAIL"} ${item.id}${item.detail ? ` — ${item.detail}` : ""}`);
  }
  console.log(report.ready ? `Release readiness: READY (${expectedVersion})` : `Release readiness: NOT READY (${expectedVersion})`);
  if (!report.ready) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
