import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runDoctor } from "../../runtime/doctor.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-delegation-doctor-"));
  mkdirSync(join(root, "runtime/manifests"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.1" }));
  writeFileSync(join(root, "src/entry.mjs"), "export const ok = true;\n");
  writeFileSync(join(root, "runtime/manifests/fixture.json"), JSON.stringify({
    schema: "orchestra.runtime-manifest.v1",
    runtime: "fixture",
    version: "1.0.1",
    sourceRoots: ["src"],
    managedAssets: [{ source: "src/entry.mjs", output: "dist/entry.mjs", type: "file" }],
    preservedProjectPaths: [".orchestra/state"],
    generatedInputs: ["src/entry.mjs"],
    entrypoints: ["dist/entry.mjs"],
  }));
  return root;
}

test("Doctor reports delegation readiness separately and keeps structurally healthy single-provider use healthy", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const report = await runDoctor({
    repoRoot: root,
    runtime: "fixture",
    runCommands: false,
    delegationInspector: async () => ({
      status: "DEGRADED",
      gitWorktree: { available: true },
      providers: [
        { provider: "codex", available: true, version: "codex 0.130.0" },
        { provider: "antigravity", available: false, reason: "PROVIDER_UNAVAILABLE" },
      ],
    }),
  });

  assert.equal(report.healthy, true);
  assert.equal(report.delegation.status, "DEGRADED");
  assert.equal(report.delegation.providers[1].available, false);
});

test("Doctor treats unavailable delegation prerequisites as advisory rather than structural failure", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const report = await runDoctor({
    repoRoot: root,
    runtime: "fixture",
    runCommands: false,
    delegationInspector: async () => ({
      status: "UNAVAILABLE",
      gitWorktree: { available: false },
      providers: [
        { provider: "codex", available: false, reason: "PROVIDER_UNAVAILABLE" },
        { provider: "antigravity", available: false, reason: "PROVIDER_UNAVAILABLE" },
      ],
    }),
  });

  assert.equal(report.healthy, true);
  assert.equal(report.delegation.status, "UNAVAILABLE");
  assert.ok(report.checks.every((entry) => entry.ok));
});
