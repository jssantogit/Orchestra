import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const diagnosticCli = fileURLToPath(new URL("../../runtimes/codex/.codex/astra-orchestra/work-lease-diagnostic-cli.mjs", import.meta.url));

function project() {
  const root = mkdtempSync(join(tmpdir(), "orch-codex-diagnostic-runtime-error-"));
  mkdirSync(join(root, ".codex", "orchestra-state"), { recursive: true });
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [diagnosticCli, "--repo-root", root], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("Work Lease diagnostic reports lease read I/O failure as runtime error, not semantic invalid state", () => {
  const root = project();
  try {
    mkdirSync(join(root, ".orchestra", "state", "work-lease.json"), { recursive: true });
    const result = run(root);
    assert.equal(result.status, 2, result.stdout || result.stderr);
    assert.equal(result.stdout, "");
    const error = JSON.parse(result.stderr);
    assert.equal(error.ok, false);
    assert.equal(error.error.code, "ORCHESTRA_WORK_LEASE_READ_FAILED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Work Lease diagnostic reports bindings read I/O failure as runtime error, not semantic invalid state", () => {
  const root = project();
  try {
    mkdirSync(join(root, ".codex", "orchestra-state", "work-lease-session-bindings.json"), { recursive: true });
    const result = run(root);
    assert.equal(result.status, 2, result.stdout || result.stderr);
    assert.equal(result.stdout, "");
    const error = JSON.parse(result.stderr);
    assert.equal(error.ok, false);
    assert.equal(error.error.code, "ORCHESTRA_WORK_LEASE_BINDINGS_READ_FAILED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
