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
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  buildRuntimeManifest,
  checkRuntimeQuiescence,
  diffProjectRuntime,
  doctorProjectRuntime,
  getProjectRuntimeVersion,
  installProjectRuntime,
  listRuntimeBackups,
  rollbackProjectRuntime,
  updateProjectRuntime,
} from "../../runtimes/antigravity/.agents/skills/orchestra/project-runtime-manager.mjs";

const orchestraRoot = fileURLToPath(new URL("../../", import.meta.url));
const realSource = join(orchestraRoot, "runtimes", "antigravity");
const sourceCli = join(orchestraRoot, "scripts", "orchestra-project.mjs");

function makeProject(prefix = "orch-project-runtime-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeSource(version, marker) {
  const root = mkdtempSync(join(tmpdir(), "orch-runtime-source-"));
  const runtime = join(root, "runtimes", "antigravity");
  mkdirSync(join(root, "runtimes"), { recursive: true });
  cpSync(realSource, runtime, {
    recursive: true,
    dereference: false,
  });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "orchestra-fixture",
    version,
    type: "module",
  }, null, 2));
  writeFileSync(
    join(runtime, ".agents", "skills", "orchestra", "fixture-version.txt"),
    marker + "\n"
  );
  return { root, runtime };
}

function writeProjectState(project, state = "DONE") {
  mkdirSync(join(project, ".agents", "state"), { recursive: true });
  writeFileSync(join(project, ".agents", "state", "active-state.json"), JSON.stringify({
    taskId: "tsuzuki-task",
    state,
    acceptanceState: state === "DONE" ? "ACCEPTED" : "PENDING",
  }, null, 2));
}

function seedPreservedProjectData(project) {
  mkdirSync(join(project, ".agents", "rules"), { recursive: true });
  mkdirSync(join(project, ".agents", "state"), { recursive: true });
  mkdirSync(join(project, ".agents", "telemetry"), { recursive: true });
  mkdirSync(join(project, ".agents", "dream-data", "worlds"), { recursive: true });
  mkdirSync(join(project, ".agents", "artifacts", "outputs"), { recursive: true });
  mkdirSync(join(project, ".agents", "semantic"), { recursive: true });

  writeFileSync(join(project, ".agents", "rules", "tsuzuki.md"), "project rule\n");
  writeFileSync(join(project, ".agents", "state", "custom-state.json"), "{\"keep\":true}\n");
  writeFileSync(join(project, ".agents", "state", "orchestrator-handoff.json"), "{\"schema\":\"orchestra.orchestrator-session-handoff.v1\",\"status\":\"ARMED\",\"keep\":true}\n");
  writeFileSync(join(project, ".agents", "telemetry", "events.jsonl"), "{\"event\":\"keep\"}\n");
  writeFileSync(join(project, ".agents", "dream-data", "worlds", "history.json"), "{\"keep\":true}\n");
  writeFileSync(join(project, ".agents", "artifacts", "outputs", "artifact.txt"), "keep\n");
  writeFileSync(join(project, ".agents", "semantic", "jev-approval.json"), "{\"keep\":true}\n");
}

function assertPreservedProjectData(project) {
  assert.equal(readFileSync(join(project, ".agents", "rules", "tsuzuki.md"), "utf8"), "project rule\n");
  assert.equal(readFileSync(join(project, ".agents", "state", "custom-state.json"), "utf8"), "{\"keep\":true}\n");
  assert.equal(
    readFileSync(join(project, ".agents", "state", "orchestrator-handoff.json"), "utf8"),
    "{\"schema\":\"orchestra.orchestrator-session-handoff.v1\",\"status\":\"ARMED\",\"keep\":true}\n"
  );
  assert.equal(readFileSync(join(project, ".agents", "telemetry", "events.jsonl"), "utf8"), "{\"event\":\"keep\"}\n");
  assert.equal(readFileSync(join(project, ".agents", "dream-data", "worlds", "history.json"), "utf8"), "{\"keep\":true}\n");
  assert.equal(readFileSync(join(project, ".agents", "artifacts", "outputs", "artifact.txt"), "utf8"), "keep\n");
  assert.equal(readFileSync(join(project, ".agents", "semantic", "jev-approval.json"), "utf8"), "{\"keep\":true}\n");
}

test("project runtime: clean install writes metadata and passes project doctor", () => {
  const project = makeProject();
  try {
    const installed = installProjectRuntime({
      sourceRuntimeRoot: realSource,
      targetDir: project,
    });

    assert.equal(installed.operation, "install");
    assert.equal(existsSync(join(project, ".agents", "orchestra-runtime.json")), true);
    assert.equal(existsSync(join(project, ".agents", "skills", "orchestra", "project-runtime-manager.mjs")), true);
    assert.equal(existsSync(join(project, ".agents", "skills", "orchestra", "project-runtime-cli.mjs")), true);
    assert.equal(existsSync(join(project, ".agents", "state", "active-state.json")), false);
    assert.equal(existsSync(join(project, ".agents", "dream-data")), false);

    const version = getProjectRuntimeVersion(project);
    assert.equal(version.installed, true);
    assert.equal(version.managed, true);
    assert.equal(version.drifted, false);

    const doctor = doctorProjectRuntime({
      targetDir: project,
      sourceRuntimeRoot: realSource,
    });
    assert.equal(doctor.healthy, true);
    assert.equal(doctor.sourceComparison.upToDate, true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});


test("project runtime: metadata-only source version advance syncs without runtime replacement or backup", () => {
  const project = makeProject();
  const v1 = makeSource("1.0.0", "same-runtime");
  const v2 = makeSource("2.0.0", "same-runtime");
  try {
    installProjectRuntime({ sourceRuntimeRoot: v1.runtime, targetDir: project });
    writeProjectState(project, "DONE");

    const beforeManifest = buildRuntimeManifest(project).hash;
    const dry = updateProjectRuntime({ sourceRuntimeRoot: v2.runtime, targetDir: project, dryRun: true });
    assert.equal(dry.diff.clean, true);
    assert.equal(dry.metadataChanged, true);
    assert.equal(listRuntimeBackups(project).length, 0);

    const result = updateProjectRuntime({ sourceRuntimeRoot: v2.runtime, targetDir: project });
    assert.equal(result.operation, "metadata-sync");
    assert.equal(result.changed, true);
    assert.equal(result.runtimeChanged, false);
    assert.equal(result.metadataChanged, true);
    assert.equal(result.backup, undefined);
    assert.equal(buildRuntimeManifest(project).hash, beforeManifest);
    assert.equal(listRuntimeBackups(project).length, 0);

    const version = getProjectRuntimeVersion(project);
    assert.equal(version.orchestraVersion, "2.0.0");
    assert.equal(version.lastOperation, "metadata-sync");

    const doctor = doctorProjectRuntime({ targetDir: project, sourceRuntimeRoot: v2.runtime });
    assert.equal(doctor.healthy, true);
    assert.equal(doctor.sourceComparison.metadataVersionMatches, true);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(v1.root, { recursive: true, force: true });
    rmSync(v2.root, { recursive: true, force: true });
  }
});

test("project runtime: update preserves all project-owned state and creates backup", () => {
  const project = makeProject();
  const v1 = makeSource("1.0.0", "v1");
  const v2 = makeSource("2.0.0", "v2");

  try {
    installProjectRuntime({
      sourceRuntimeRoot: v1.runtime,
      targetDir: project,
    });
    seedPreservedProjectData(project);
    writeProjectState(project, "DONE");

    const result = updateProjectRuntime({
      sourceRuntimeRoot: v2.runtime,
      targetDir: project,
    });

    assert.equal(result.changed, true);
    assert.ok(result.backup.backupId);
    assert.equal(
      readFileSync(join(project, ".agents", "skills", "orchestra", "fixture-version.txt"), "utf8"),
      "v2\n"
    );
    assertPreservedProjectData(project);

    const metadata = JSON.parse(
      readFileSync(join(project, ".agents", "orchestra-runtime.json"), "utf8")
    );
    assert.equal(metadata.orchestraVersion, "2.0.0");
    assert.equal(metadata.previousBackupId, result.backup.backupId);
    assert.equal(listRuntimeBackups(project).length, 1);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(v1.root, { recursive: true, force: true });
    rmSync(v2.root, { recursive: true, force: true });
  }
});

test("project runtime: legacy unmanaged runtime can be adopted without losing state", () => {
  const project = makeProject();
  try {
    // Simulate the manual installation/update process used by Tsuzuki before
    // project runtime management existed.
    mkdirSync(join(project, ".agents"), { recursive: true });
    for (const rel of [
      ".agents/agents",
      ".agents/hooks",
      ".agents/skills",
      ".agents/dream",
    ]) {
      cpSync(join(realSource, rel), join(project, rel), {
        recursive: true,
        dereference: false,
      });
    }
    cpSync(join(realSource, ".agents", "hooks.json"), join(project, ".agents", "hooks.json"));
    cpSync(join(realSource, "GEMINI.md"), join(project, "GEMINI.md"));

    seedPreservedProjectData(project);
    writeProjectState(project, "HUMAN_GATE");

    assert.equal(existsSync(join(project, ".agents", "orchestra-runtime.json")), false);

    const result = updateProjectRuntime({
      sourceRuntimeRoot: realSource,
      targetDir: project,
    });

    assert.equal(result.changed, true);
    assert.equal(existsSync(join(project, ".agents", "orchestra-runtime.json")), true);
    assert.equal(listRuntimeBackups(project).length, 1);
    assertPreservedProjectData(project);

    const state = JSON.parse(
      readFileSync(join(project, ".agents", "state", "active-state.json"), "utf8")
    );
    assert.equal(state.state, "HUMAN_GATE");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project runtime: dry-run reports update without mutating target", () => {
  const project = makeProject();
  const v1 = makeSource("1.0.0", "before");
  const v2 = makeSource("2.0.0", "after");

  try {
    installProjectRuntime({
      sourceRuntimeRoot: v1.runtime,
      targetDir: project,
    });
    writeProjectState(project, "DONE");
    const before = buildRuntimeManifest(project).hash;

    const result = updateProjectRuntime({
      sourceRuntimeRoot: v2.runtime,
      targetDir: project,
      dryRun: true,
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.diff.clean, false);
    assert.equal(buildRuntimeManifest(project).hash, before);
    assert.equal(listRuntimeBackups(project).length, 0);
    assert.equal(
      readFileSync(join(project, ".agents", "skills", "orchestra", "fixture-version.txt"), "utf8"),
      "before\n"
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(v1.root, { recursive: true, force: true });
    rmSync(v2.root, { recursive: true, force: true });
  }
});

test("project runtime: active execution blocks update unless forced", () => {
  const project = makeProject();
  try {
    installProjectRuntime({
      sourceRuntimeRoot: realSource,
      targetDir: project,
    });
    writeProjectState(project, "EXECUTING");

    const q = checkRuntimeQuiescence(project);
    assert.equal(q.safe, false);
    assert.equal(q.reason, "RUNTIME_ACTIVE_EXECUTING");

    assert.throws(() => {
      updateProjectRuntime({
        sourceRuntimeRoot: realSource,
        targetDir: project,
      });
    }, /RUNTIME_NOT_QUIESCENT/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project runtime: HUMAN_GATE is quiescent so broken runtimes remain repairable", () => {
  const project = makeProject();
  try {
    installProjectRuntime({
      sourceRuntimeRoot: realSource,
      targetDir: project,
    });
    writeProjectState(project, "HUMAN_GATE");

    const q = checkRuntimeQuiescence(project);
    assert.equal(q.safe, true);
    assert.equal(q.reason, "QUIESCENT_HUMAN_GATE");

    const result = updateProjectRuntime({
      sourceRuntimeRoot: realSource,
      targetDir: project,
    });
    assert.equal(result.changed, false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project runtime: rollback restores runtime but preserves current project state", () => {
  const project = makeProject();
  const v1 = makeSource("1.0.0", "v1");
  const v2 = makeSource("2.0.0", "v2");

  try {
    installProjectRuntime({
      sourceRuntimeRoot: v1.runtime,
      targetDir: project,
    });
    seedPreservedProjectData(project);
    writeProjectState(project, "DONE");

    const update = updateProjectRuntime({
      sourceRuntimeRoot: v2.runtime,
      targetDir: project,
    });
    assert.equal(
      readFileSync(join(project, ".agents", "skills", "orchestra", "fixture-version.txt"), "utf8"),
      "v2\n"
    );

    // Change project-owned state after the update. Rollback must not rewind it.
    writeFileSync(join(project, ".agents", "state", "custom-state.json"), "{\"keep\":\"new\"}\n");

    const rolled = rollbackProjectRuntime({
      targetDir: project,
      backupId: update.backup.backupId,
    });

    assert.equal(
      readFileSync(join(project, ".agents", "skills", "orchestra", "fixture-version.txt"), "utf8"),
      "v1\n"
    );
    assert.equal(
      readFileSync(join(project, ".agents", "state", "custom-state.json"), "utf8"),
      "{\"keep\":\"new\"}\n"
    );
    assert.ok(rolled.safetyBackup.backupId);

    const metadata = getProjectRuntimeVersion(project);
    assert.equal(metadata.orchestraVersion, "1.0.0");
    assert.equal(metadata.lastOperation, "rollback");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(v1.root, { recursive: true, force: true });
    rmSync(v2.root, { recursive: true, force: true });
  }
});

test("project runtime: doctor detects managed runtime drift", () => {
  const project = makeProject();
  try {
    installProjectRuntime({
      sourceRuntimeRoot: realSource,
      targetDir: project,
    });

    writeFileSync(
      join(project, ".agents", "hooks", "stop-guard.mjs"),
      "\n// drift\n",
      { flag: "a" }
    );

    const doctor = doctorProjectRuntime({
      targetDir: project,
      sourceRuntimeRoot: realSource,
    });

    assert.equal(doctor.healthy, false);
    assert.equal(
      doctor.checks.find((item) => item.id === "RUNTIME_INTEGRITY").ok,
      false
    );
    assert.equal(doctor.sourceComparison.upToDate, false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project runtime: diff-runtime reports changed managed files", () => {
  const project = makeProject();
  try {
    installProjectRuntime({
      sourceRuntimeRoot: realSource,
      targetDir: project,
    });

    writeFileSync(
      join(project, ".agents", "hooks", "stop-guard.mjs"),
      "\n// changed\n",
      { flag: "a" }
    );

    const diff = diffProjectRuntime({
      sourceRuntimeRoot: realSource,
      targetDir: project,
    });

    assert.equal(diff.clean, false);
    assert.ok(diff.changed.includes(".agents/hooks/stop-guard.mjs"));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project runtime CLI: version and doctor work from source wrapper", () => {
  const project = makeProject();
  try {
    execFileSync(process.execPath, [sourceCli, "install", project], { encoding: "utf8" });

    const version = execFileSync(
      process.execPath,
      [sourceCli, "version", project, "--json"],
      { encoding: "utf8" }
    );
    const parsedVersion = JSON.parse(version);
    assert.equal(parsedVersion.installed, true);
    assert.equal(parsedVersion.managed, true);

    const doctor = execFileSync(
      process.execPath,
      [sourceCli, "doctor", project, "--json"],
      { encoding: "utf8" }
    );
    const parsedDoctor = JSON.parse(doctor);
    assert.equal(parsedDoctor.healthy, true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
