import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const orchestraRoot = fileURLToPath(new URL("../../", import.meta.url));
const installScript = join(orchestraRoot, "scripts", "install-antigravity.mjs");
const projectCli = join(orchestraRoot, "scripts", "orchestra-project.mjs");

function runNode(args, cwd = orchestraRoot) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: process.env.CI || "1" },
  });
}

function makeProject() {
  return mkdtempSync(join(tmpdir(), "orchestra-antigravity-v2-doctor-"));
}

function parseJsonOutput(result) {
  assert.equal(result.status, 0, `command failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("official Antigravity install is immediately healthy under the source-level Doctor", () => {
  const project = makeProject();
  try {
    const install = runNode([installScript, project]);
    assert.equal(install.status, 0, `install failed\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`);

    const metadataPath = join(project, ".orchestra", "state", "runtimes", "antigravity.json");
    const legacyMetadataPath = join(project, ".agents", "orchestra-runtime.json");
    assert.equal(existsSync(metadataPath), true);
    assert.equal(existsSync(legacyMetadataPath), false);

    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    assert.equal(metadata.schema, "orchestra.project-runtime.v2");
    assert.equal(metadata.runtime, "antigravity");

    const doctor = parseJsonOutput(runNode([projectCli, "doctor", project, "--json"]));
    assert.equal(doctor.healthy, true);
    assert.equal(doctor.status, "HEALTHY");
    assert.equal(doctor.inspection.metadataCurrent, true);
    assert.equal(doctor.inspection.diff.clean, true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("source-level Antigravity update keeps v2 metadata authoritative", () => {
  const project = makeProject();
  try {
    const install = runNode([installScript, project]);
    assert.equal(install.status, 0, `install failed\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`);

    const update = parseJsonOutput(runNode([projectCli, "update", project, "--json"]));
    assert.equal(update.changed, false);
    assert.equal(update.operation, "noop");
    assert.equal(existsSync(join(project, ".agents", "orchestra-runtime.json")), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("source-level Antigravity update remains blocked while runtime state is active", () => {
  const project = makeProject();
  try {
    const install = runNode([installScript, project]);
    assert.equal(install.status, 0, `install failed\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`);

    const stateDir = join(project, ".agents", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "active-state.json"), JSON.stringify({ taskId: "active", state: "EXECUTING" }, null, 2));

    const managedFile = join(project, ".agents", "skills", "orchestra", "routing-policy.mjs");
    writeFileSync(managedFile, `${readFileSync(managedFile, "utf8")}\n// force-update\n`);

    const update = runNode([projectCli, "update", project, "--json"]);
    assert.equal(update.status, 2);
    assert.match(update.stderr, /RUNTIME_NOT_QUIESCENT: RUNTIME_ACTIVE_EXECUTING/);
    assert.match(readFileSync(managedFile, "utf8"), /force-update/);
    assert.equal(existsSync(join(project, ".agents", "orchestra-runtime.json")), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Antigravity Doctor fails closed on managed runtime drift", () => {
  const project = makeProject();
  try {
    const install = runNode([installScript, project]);
    assert.equal(install.status, 0, `install failed\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`);

    const managedFile = join(project, ".agents", "skills", "orchestra", "routing-policy.mjs");
    writeFileSync(managedFile, `${readFileSync(managedFile, "utf8")}\n// drift\n`);

    const doctor = runNode([projectCli, "doctor", project, "--json"]);
    assert.equal(doctor.status, 1, `Doctor should fail closed on drift\nstdout:\n${doctor.stdout}\nstderr:\n${doctor.stderr}`);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.healthy, false);
    assert.equal(report.inspection.diff.clean, false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
