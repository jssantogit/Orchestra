#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIMES = Object.freeze(["core", "codex", "antigravity"]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function check(id, ok, detail = "") {
  return { id, ok: Boolean(ok), detail };
}

export function checkReleaseReadiness({ repoRoot = moduleRoot, expectedVersion } = {}) {
  const root = resolve(repoRoot);
  const checks = [];
  let packageVersion = null;
  let lock = null;
  try {
    packageVersion = readJson(join(root, "package.json")).version;
  } catch (error) {
    checks.push(check("version:package", false, error.message));
  }
  if (packageVersion !== null) {
    checks.push(check("version:package", packageVersion === expectedVersion, `expected=${expectedVersion}; actual=${packageVersion}`));
  }

  try {
    lock = readJson(join(root, "package-lock.json"));
    const lockVersion = lock?.packages?.[""]?.version ?? lock?.version;
    checks.push(check("version:lock", lockVersion === expectedVersion, `expected=${expectedVersion}; actual=${lockVersion}`));
  } catch (error) {
    checks.push(check("version:lock", false, error.message));
  }

  for (const runtime of RUNTIMES) {
    try {
      const manifest = readJson(join(root, "runtime", "manifests", `${runtime}.json`));
      checks.push(check(`version:manifest:${runtime}`, manifest.version === expectedVersion, `expected=${expectedVersion}; actual=${manifest.version}`));
    } catch (error) {
      checks.push(check(`version:manifest:${runtime}`, false, error.message));
    }
  }

  const migrationPath = join(root, "docs/migrations/0.10-to-1.x.md");
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

  const checklistPath = join(root, "docs/release/1.x-checklist.md");
  checks.push(check("docs:release-checklist", existsSync(checklistPath), existsSync(checklistPath) ? "present" : "missing docs/release/1.x-checklist.md"));

  return {
    expectedVersion,
    ready: checks.length > 0 && checks.every((item) => item.ok),
    checks,
  };
}

function main() {
  const arg = process.argv.find((value) => value.startsWith("--expected-version="));
  const expectedVersion = arg?.slice("--expected-version=".length) || readJson(join(moduleRoot, "package.json")).version;
  const report = checkReleaseReadiness({ expectedVersion });
  for (const item of report.checks) {
    console.log(`${item.ok ? "PASS" : "FAIL"} ${item.id}${item.detail ? ` — ${item.detail}` : ""}`);
  }
  console.log(report.ready ? `Release readiness: READY (${expectedVersion})` : `Release readiness: NOT READY (${expectedVersion})`);
  if (!report.ready) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
