import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  buildCodexRuntimeManifest,
  checkCodexRuntimeQuiescence,
  diffCodexProjectRuntime,
  doctorCodexProjectRuntime,
  getCodexProjectRuntimeVersion,
  installCodexProjectRuntime,
  listCodexRuntimeBackups,
  rollbackCodexProjectRuntime,
  updateCodexProjectRuntime,
} from "../../runtimes/codex/.codex/astra-orchestra/codex-runtime-manager.mjs";

const orchestraRoot = fileURLToPath(new URL("../../", import.meta.url));
const realSource = join(orchestraRoot, "runtimes", "codex");
const sourceCli = join(orchestraRoot, "scripts", "orchestra-codex-project.mjs");

function makeProject(prefix = "orch-codex-project-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeSource(version, marker) {
  const root = mkdtempSync(join(tmpdir(), "orch-codex-source-"));
  const runtime = join(root, "runtimes", "codex");
  mkdirSync(join(root, "runtimes"), { recursive: true });
  cpSync(realSource, runtime, { recursive: true, dereference: false });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "orchestra-codex-fixture",
    version,
    type: "module",
  }, null, 2));
  writeFileSync(join(runtime, ".codex", "astra-orchestra", "fixture-version.txt"), marker + "\n");
  return { root, runtime };
}

function writeState(project, state = "DONE") {
  mkdirSync(join(project, ".codex", "orchestra-state"), { recursive: true });
  writeFileSync(join(project, ".codex", "orchestra-state", "active-state.json"), JSON.stringify({
    taskId: "codex-task",
    state,
  }, null, 2));
}

function seedPreserved(project) {
  const paths = [
    [".codex/orchestra-state/custom.json", "{\"keep\":true}\n"],
    [".codex/orchestra-telemetry/events.jsonl", "{\"event\":\"keep\"}\n"],
    [".codex/orchestra-artifacts/outputs/a.txt", "keep\n"],
    [".codex/orchestra-semantic/approval.json", "{\"keep\":true}\n"],
  ];
  for (const [rel, content] of paths) {
    mkdirSync(join(project, rel, ".."), { recursive: true });
    writeFileSync(join(project, rel), content);
  }
}

function assertPreserved(project) {
  assert.equal(readFileSync(join(project, ".codex/orchestra-state/custom.json"), "utf8"), "{\"keep\":true}\n");
  assert.equal(readFileSync(join(project, ".codex/orchestra-telemetry/events.jsonl"), "utf8"), "{\"event\":\"keep\"}\n");
  assert.equal(readFileSync(join(project, ".codex/orchestra-artifacts/outputs/a.txt"), "utf8"), "keep\n");
  assert.equal(readFileSync(join(project, ".codex/orchestra-semantic/approval.json"), "utf8"), "{\"keep\":true}\n");
}

test("Codex project runtime clean install is managed and healthy", () => {
  const project = makeProject();
  try {
    const installed = installCodexProjectRuntime({ sourceRuntimeRoot: realSource, targetDir: project });
    assert.equal(installed.operation, "install");
    assert.equal(existsSync(join(project, ".codex/config.toml")), true);
    assert.equal(existsSync(join(project, ".codex/astra-orchestra/codex-runtime-manager.mjs")), true);
    assert.equal(existsSync(join(project, ".codex/orchestra-runtime.json")), true);

    const version = getCodexProjectRuntimeVersion(project);
    assert.equal(version.installed, true);
    assert.equal(version.managed, true);
    assert.equal(version.drifted, false);

    const doctor = doctorCodexProjectRuntime({ targetDir: project, sourceRuntimeRoot: realSource });
    assert.equal(doctor.healthy, true);
    assert.equal(doctor.sourceComparison.upToDate, true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Codex update preserves project-owned state and creates backup", () => {
  const project = makeProject();
  const v1 = makeSource("1.0.0", "v1");
  const v2 = makeSource("2.0.0", "v2");
  try {
    installCodexProjectRuntime({ sourceRuntimeRoot: v1.runtime, targetDir: project });
    seedPreserved(project);
    writeState(project, "DONE");

    const result = updateCodexProjectRuntime({ sourceRuntimeRoot: v2.runtime, targetDir: project });
    assert.equal(result.changed, true);
    assert.ok(result.backup.backupId);
    assert.equal(readFileSync(join(project, ".codex/astra-orchestra/fixture-version.txt"), "utf8"), "v2\n");
    assertPreserved(project);
    assert.equal(getCodexProjectRuntimeVersion(project).orchestraVersion, "2.0.0");
    assert.equal(listCodexRuntimeBackups(project).length, 1);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(v1.root, { recursive: true, force: true });
    rmSync(v2.root, { recursive: true, force: true });
  }
});

test("Codex update can adopt a legacy unmanaged .codex runtime", () => {
  const project = makeProject();
  try {
    mkdirSync(join(project, ".codex"), { recursive: true });
    cpSync(join(realSource, ".codex/config.toml"), join(project, ".codex/config.toml"));
    cpSync(join(realSource, ".codex/agents"), join(project, ".codex/agents"), { recursive: true });
    cpSync(join(realSource, ".codex/astra-orchestra"), join(project, ".codex/astra-orchestra"), { recursive: true });
    seedPreserved(project);
    writeState(project, "HUMAN_GATE");

    const result = updateCodexProjectRuntime({ sourceRuntimeRoot: realSource, targetDir: project });
    assert.equal(result.operation, "adopt");
    assert.equal(existsSync(join(project, ".codex/orchestra-runtime.json")), true);
    assertPreserved(project);
    assert.equal(listCodexRuntimeBackups(project).length, 1);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Codex dry-run is non-mutating", () => {
  const project = makeProject();
  const v1 = makeSource("1.0.0", "before");
  const v2 = makeSource("2.0.0", "after");
  try {
    installCodexProjectRuntime({ sourceRuntimeRoot: v1.runtime, targetDir: project });
    writeState(project, "DONE");
    const before = buildCodexRuntimeManifest(project).hash;
    const result = updateCodexProjectRuntime({ sourceRuntimeRoot: v2.runtime, targetDir: project, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.diff.clean, false);
    assert.equal(buildCodexRuntimeManifest(project).hash, before);
    assert.equal(readFileSync(join(project, ".codex/astra-orchestra/fixture-version.txt"), "utf8"), "before\n");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(v1.root, { recursive: true, force: true });
    rmSync(v2.root, { recursive: true, force: true });
  }
});

test("Codex active task blocks runtime update", () => {
  const project = makeProject();
  try {
    installCodexProjectRuntime({ sourceRuntimeRoot: realSource, targetDir: project });
    writeState(project, "EXECUTING");
    assert.equal(checkCodexRuntimeQuiescence(project).safe, false);
    assert.throws(() => updateCodexProjectRuntime({ sourceRuntimeRoot: realSource, targetDir: project }), /CODEX_RUNTIME_NOT_QUIESCENT/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Codex rollback restores managed runtime but not project state", () => {
  const project = makeProject();
  const v1 = makeSource("1.0.0", "v1");
  const v2 = makeSource("2.0.0", "v2");
  try {
    installCodexProjectRuntime({ sourceRuntimeRoot: v1.runtime, targetDir: project });
    seedPreserved(project);
    writeState(project, "DONE");
    const update = updateCodexProjectRuntime({ sourceRuntimeRoot: v2.runtime, targetDir: project });
    writeFileSync(join(project, ".codex/orchestra-state/custom.json"), "{\"keep\":\"new\"}\n");
    const rolled = rollbackCodexProjectRuntime({ targetDir: project, backupId: update.backup.backupId });
    assert.equal(readFileSync(join(project, ".codex/astra-orchestra/fixture-version.txt"), "utf8"), "v1\n");
    assert.equal(readFileSync(join(project, ".codex/orchestra-state/custom.json"), "utf8"), "{\"keep\":\"new\"}\n");
    assert.ok(rolled.safetyBackup.backupId);
    assert.equal(getCodexProjectRuntimeVersion(project).orchestraVersion, "1.0.0");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(v1.root, { recursive: true, force: true });
    rmSync(v2.root, { recursive: true, force: true });
  }
});

test("Codex doctor and diff detect managed drift", () => {
  const project = makeProject();
  try {
    installCodexProjectRuntime({ sourceRuntimeRoot: realSource, targetDir: project });
    writeFileSync(join(project, ".codex/astra-orchestra/dream-lab.mjs"), "\n// drift\n", { flag: "a" });
    assert.equal(doctorCodexProjectRuntime({ targetDir: project, sourceRuntimeRoot: realSource }).healthy, false);
    const diff = diffCodexProjectRuntime({ sourceRuntimeRoot: realSource, targetDir: project });
    assert.equal(diff.clean, false);
    assert.ok(diff.changed.includes(".codex/astra-orchestra/dream-lab.mjs"));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Codex source wrapper exposes version and doctor", () => {
  const project = makeProject();
  try {
    execFileSync(process.execPath, [sourceCli, "install", project], { encoding: "utf8" });
    const version = JSON.parse(execFileSync(process.execPath, [sourceCli, "version", project, "--json"], { encoding: "utf8" }));
    assert.equal(version.managed, true);
    assert.equal(version.runtime, "CODEX");
    const doctor = JSON.parse(execFileSync(process.execPath, [sourceCli, "doctor", project, "--json"], { encoding: "utf8" }));
    assert.equal(doctor.healthy, true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
