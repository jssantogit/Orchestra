import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkReleaseReadiness } from "../../scripts/release-readiness.mjs";

const REQUIRED_SCRIPTS = [
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
];

function fixture({ version = "1.0.0-rc.0", migration = true, scripts = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-release-readiness-"));
  mkdirSync(join(root, "runtime/manifests"), { recursive: true });
  mkdirSync(join(root, "docs/migrations"), { recursive: true });
  mkdirSync(join(root, "docs/release"), { recursive: true });
  mkdirSync(join(root, "core/schema/generated"), { recursive: true });
  mkdirSync(join(root, "schemas"), { recursive: true });
  const packageScripts = Object.fromEntries(REQUIRED_SCRIPTS.map((name) => [name, "node -e \"\""]));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version, ...(scripts ? { scripts: packageScripts } : {}) }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ version, packages: { "": { version } } }));
  writeFileSync(join(root, "core/schema/generated/implementation-packet.v1.mjs"), "export default {};\n");
  writeFileSync(join(root, "schemas/implementation-packet.v1.schema.json"), "{}\n");
  for (const runtime of ["core", "codex", "antigravity"]) {
    writeFileSync(join(root, `runtime/manifests/${runtime}.json`), JSON.stringify({ runtime, version }));
  }
  if (migration) {
    writeFileSync(join(root, "docs/migrations/0.10-to-1.x.md"), [
      "ORCHESTRA_DIRECT_WORK_MODE=off|shadow|on",
      "ORCHESTRA_AUTHORITY_MODE=session|dual|lease",
      "runtime update rollback preserved state",
    ].join("\n"));
  }
  writeFileSync(join(root, "docs/release/1.x-checklist.md"), "RC checklist\nTask 9 — operator approval required\nDo not bump stable version to 1.0.0 without approval.\n");
  return root;
}

test("release readiness accepts coherent RC metadata, gates, and rollback documentation", () => {
  const root = fixture();
  try {
    const report = checkReleaseReadiness({ repoRoot: root, expectedVersion: "1.0.0-rc.0" });
    assert.equal(report.ready, true);
    assert.deepEqual(report.failures, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release readiness fails closed on version drift", () => {
  const root = fixture({ version: "0.10.0" });
  try {
    const report = checkReleaseReadiness({ repoRoot: root, expectedVersion: "1.0.0-rc.0" });
    assert.equal(report.ready, false);
    assert.ok(report.failures.some((item) => item.id === "version:package"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release readiness requires documented rollback levers", () => {
  const root = fixture({ migration: false });
  try {
    const report = checkReleaseReadiness({ repoRoot: root, expectedVersion: "1.0.0-rc.0" });
    assert.equal(report.ready, false);
    assert.ok(report.failures.some((item) => item.id === "docs:migration"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release readiness rejects missing executable release gates", () => {
  const root = fixture({ scripts: false });
  try {
    const report = checkReleaseReadiness({ repoRoot: root, expectedVersion: "1.0.0-rc.0" });
    assert.equal(report.ready, false);
    assert.ok(report.failures.some((item) => item.id === "gates:package-scripts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
