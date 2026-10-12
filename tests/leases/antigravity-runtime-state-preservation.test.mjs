import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  installProjectRuntime,
  rollbackProjectRuntime,
  updateProjectRuntime,
} from "../../runtimes/antigravity/.agents/skills/orchestra/project-runtime-manager.mjs";
import { enterAntigravityWorkLease } from "../../runtimes/antigravity/.agents/skills/orchestra/work-lease-authority.mjs";

const orchestraRoot = fileURLToPath(new URL("../../", import.meta.url));
const realSource = join(orchestraRoot, "runtimes", "antigravity");

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function project() {
  const root = mkdtempSync(join(tmpdir(), "orch-agy-neutral-state-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "product.txt"), "v1\n");
  git(root, "add", "product.txt");
  git(root, "commit", "-qm", "init");
  return root;
}

function source(version, marker) {
  const root = mkdtempSync(join(tmpdir(), "orch-agy-neutral-source-"));
  const runtime = join(root, "runtimes", "antigravity");
  mkdirSync(join(root, "runtimes"), { recursive: true });
  cpSync(realSource, runtime, { recursive: true, dereference: false });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version, type: "module" }, null, 2));
  writeFileSync(join(runtime, ".agents", "skills", "orchestra", "lease-fixture.txt"), `${marker}\n`);
  return { root, runtime };
}

test("Antigravity update and rollback preserve and locally ignore neutral Work Lease state", () => {
  const target = project();
  const v1 = source("1.0.0", "v1");
  const v2 = source("2.0.0", "v2");
  try {
    installProjectRuntime({ sourceRuntimeRoot: v1.runtime, targetDir: target });
    writeFileSync(join(target, ".agents", "state", "active-state.json"), JSON.stringify({
      taskId: "task-1",
      state: "DONE",
      candidateId: "candidate-7",
    }, null, 2));

    const claim = enterAntigravityWorkLease(target, {
      conversationId: "root-a",
      profile: "flash-orchestrator",
      mode: "dual",
    });
    assert.equal(claim.authoritative, true);
    const leasePath = join(target, ".orchestra", "state", "work-lease.json");
    const before = readFileSync(leasePath, "utf8");
    assert.match(readFileSync(join(target, ".git", "info", "exclude"), "utf8"), /\.orchestra\/state\/\*\*/);
    assert.equal(git(target, "status", "--short", "--", ".orchestra/state"), "");

    const updated = updateProjectRuntime({ sourceRuntimeRoot: v2.runtime, targetDir: target });
    assert.equal(readFileSync(leasePath, "utf8"), before);

    rollbackProjectRuntime({ targetDir: target, backupId: updated.backup.backupId });
    assert.equal(readFileSync(leasePath, "utf8"), before);
    assert.equal(git(target, "status", "--short", "--", ".orchestra/state"), "");
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(v1.root, { recursive: true, force: true });
    rmSync(v2.root, { recursive: true, force: true });
  }
});
