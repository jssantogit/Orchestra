import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runDoctor } from "../../runtime/doctor.mjs";

function fixture({ manifestVersion = "1.0.0-rc.0", missingSource = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-doctor-"));
  mkdirSync(join(root, "runtime/manifests"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0-rc.0" }));
  if (!missingSource) writeFileSync(join(root, "src/entry.mjs"), "export const ok = true;\n");
  const manifest = {
    schema: "orchestra.runtime-manifest.v1",
    runtime: "fixture",
    version: manifestVersion,
    sourceRoots: ["src"],
    managedAssets: [{ source: "src/entry.mjs", output: "dist/entry.mjs", type: "file" }],
    preservedProjectPaths: [".orchestra/state"],
    generatedInputs: ["src/entry.mjs"],
    entrypoints: ["dist/entry.mjs"],
  };
  writeFileSync(join(root, "runtime/manifests/fixture.json"), JSON.stringify(manifest, null, 2));
  return root;
}

test("Doctor reports healthy manifest/version/assets for a bounded fixture", async () => {
  const root = fixture();
  try {
    const report = await runDoctor({ repoRoot: root, runtime: "fixture", runCommands: false });
    assert.equal(report.healthy, true);
    assert.ok(report.checks.every((check) => check.ok));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Doctor fails closed on manifest/package version drift", async () => {
  const root = fixture({ manifestVersion: "0.10.0" });
  try {
    const report = await runDoctor({ repoRoot: root, runtime: "fixture", runCommands: false });
    assert.equal(report.healthy, false);
    assert.ok(report.checks.some((check) => check.id === "fixture:version-coherence" && !check.ok));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Doctor fails closed when a manifest-owned source asset is missing", async () => {
  const root = fixture({ missingSource: true });
  try {
    const report = await runDoctor({ repoRoot: root, runtime: "fixture", runCommands: false });
    assert.equal(report.healthy, false);
    assert.ok(report.checks.some((check) => check.id === "fixture:managed-assets" && !check.ok));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
