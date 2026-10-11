import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkReleaseReadiness } from "../../scripts/release-readiness.mjs";

function fixture({ version = "1.0.0-rc.0", migration = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-release-readiness-"));
  mkdirSync(join(root, "runtime/manifests"), { recursive: true });
  mkdirSync(join(root, "docs/migrations"), { recursive: true });
  mkdirSync(join(root, "docs/release"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ version, packages: { "": { version } } }));
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
  writeFileSync(join(root, "docs/release/1.x-checklist.md"), "RC checklist\nTask 9 operator approval\n");
  return root;
}

test("release readiness accepts coherent RC metadata and rollback documentation", () => {
  const root = fixture();
  try {
    const report = checkReleaseReadiness({ repoRoot: root, expectedVersion: "1.0.0-rc.0" });
    assert.equal(report.ready, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release readiness fails closed on version drift", () => {
  const root = fixture({ version: "0.10.0" });
  try {
    const report = checkReleaseReadiness({ repoRoot: root, expectedVersion: "1.0.0-rc.0" });
    assert.equal(report.ready, false);
    assert.ok(report.checks.some((item) => item.id === "version:package" && !item.ok));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release readiness requires documented rollback levers", () => {
  const root = fixture({ migration: false });
  try {
    const report = checkReleaseReadiness({ repoRoot: root, expectedVersion: "1.0.0-rc.0" });
    assert.equal(report.ready, false);
    assert.ok(report.checks.some((item) => item.id === "docs:migration" && !item.ok));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
