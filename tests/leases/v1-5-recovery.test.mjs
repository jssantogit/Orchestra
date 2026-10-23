import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { claimWorkLease, readWorkLease } from "../../core/leases/work-lease-store.mjs";

const cli = fileURLToPath(new URL("../../scripts/orchestra-recover.mjs", import.meta.url));
const owner = { provider: "codex", sessionIdHash: "sha256:" + "f".repeat(64) };

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "orchestra-v15-recovery-"));
  git(root, "init", "-q");
  writeFileSync(join(root, "readme.md"), "baseline\n");
  git(root, "add", "readme.md");
  git(root, "-c", "user.name=Orchestra Test", "-c", "user.email=orchestra@example.invalid", "commit", "-qm", "baseline");
  return root;
}

function cliResult(root, ...args) {
  const run = spawnSync(process.execPath, [cli, ...args, "--repo-root", root], { cwd: root, encoding: "utf8", timeout: 15_000 });
  return {
    code: run.status,
    output: JSON.parse(run.status === 0 ? run.stdout : run.stderr),
  };
}

test("recovery inspect is read-only and cannot declare an orphan from timeout alone", () => {
  const root = fixture();
  try {
    const first = claimWorkLease(root, { taskId: "m1", actor: owner, capabilities: ["WORKSPACE_EDIT"] });
    const before = readFileSync(join(root, ".orchestra", "state", "work-lease.json"), "utf8");
    const status = cliResult(root, "inspect");
    assert.equal(status.code, 0);
    assert.equal(status.output.status, "WRITER_LIVENESS_UNKNOWN");
    assert.equal(status.output.canAutoRecover, false);
    assert.equal(status.output.workspace, "CLEAN");
    assert.equal(readFileSync(join(root, ".orchestra", "state", "work-lease.json"), "utf8"), before);
    assert.equal(first.lease.generation, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("manual recovery requires old session closed and exact generation, then fences old actor", () => {
  const root = fixture();
  try {
    claimWorkLease(root, { taskId: "m1", actor: owner, capabilities: ["WORKSPACE_EDIT"] });
    const denied = cliResult(root, "abandon", "--expected-generation", "0");
    assert.notEqual(denied.code, 0);
    assert.equal(denied.output.code, "RECOVERY_EXPLICIT_CONFIRMATION_REQUIRED");
    assert.ok(readWorkLease(root).lease.capabilities.includes("WORKSPACE_EDIT"));
    const wrong = cliResult(root, "abandon", "--expected-generation", "1", "--confirm-old-session-closed");
    assert.notEqual(wrong.code, 0);
    assert.equal(wrong.output.code, "RECOVERY_STALE_GENERATION");
    const recovered = cliResult(root, "abandon", "--expected-generation", "0", "--confirm-old-session-closed");
    assert.equal(recovered.code, 0, JSON.stringify(recovered.output));
    assert.equal(recovered.output.recovered, true);
    const lease = readWorkLease(root).lease;
    assert.equal(lease.state, "BLOCKED");
    assert.deepEqual(lease.capabilities, []);
    assert.equal(lease.generation, 0);
    const next = claimWorkLease(root, { taskId: "m1", actor: { provider: "codex", sessionIdHash: "sha256:" + "e".repeat(64) }, capabilities: ["CONTROL"], expectedGeneration: 0 });
    assert.equal(next.claimed, true);
    assert.equal(next.lease.generation, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dirty recovery never discards work and requires a separate explicit preservation confirmation", () => {
  const root = fixture();
  try {
    claimWorkLease(root, { taskId: "m1", actor: owner, capabilities: ["WORKSPACE_EDIT"] });
    writeFileSync(join(root, "readme.md"), "uncommitted valuable change\n");
    const status = cliResult(root, "inspect");
    assert.equal(status.output.workspace, "DIRTY");
    const denied = cliResult(root, "abandon", "--expected-generation", "0", "--confirm-old-session-closed");
    assert.notEqual(denied.code, 0);
    assert.equal(denied.output.code, "RECOVERY_DIRTY_WORKSPACE_CONFIRMATION_REQUIRED");
    assert.ok(readWorkLease(root).lease.capabilities.includes("WORKSPACE_EDIT"));
    const preserved = cliResult(root, "abandon", "--expected-generation", "0", "--confirm-old-session-closed", "--preserve-dirty");
    assert.equal(preserved.code, 0, JSON.stringify(preserved.output));
    assert.equal(readFileSync(join(root, "readme.md"), "utf8"), "uncommitted valuable change\n");
    assert.equal(preserved.output.workspace, "DIRTY");
    assert.equal(readWorkLease(root).lease.state, "BLOCKED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid Work Lease refuses recovery and preserves bytes", () => {
  const root = fixture();
  try {
    claimWorkLease(root, { taskId: "m1", actor: owner, capabilities: ["WORKSPACE_EDIT"] });
    const path = join(root, ".orchestra", "state", "work-lease.json");
    writeFileSync(path, "{malformed");
    const result = cliResult(root, "abandon", "--expected-generation", "0", "--confirm-old-session-closed");
    assert.notEqual(result.code, 0);
    assert.equal(result.output.code, "RECOVERY_LEASE_UNKNOWN");
    assert.equal(readFileSync(path, "utf8"), "{malformed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
