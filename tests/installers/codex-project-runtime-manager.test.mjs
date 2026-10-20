import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
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
import {
  buildCodexV2ShimArtifacts,
  installCodexV2Shim,
} from "../../v2/providers/codex/shim-manager.mjs";

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
    assert.equal(existsSync(join(project, ".codex/hooks.json")), true);
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

test("Codex v2 shim installs only hook config and thin transport shim", () => {
  const project = makeProject();
  const global = makeProject("orch-global-launcher-");
  const launcher = join(global, "cli.mjs");
  const orchestraHome = relative(process.cwd(), join(global, "orchestra-home"));
  mkdirSync(project, { recursive: true });
  writeFileSync(launcher, "process.stdin.pipe(process.stdout);\n");
  try {
    const installed = installCodexV2Shim({ targetDir: project, launcherPath: launcher, orchestraHome });
    assert.equal(installed.ok, true);
    assert.deepEqual([...installed.files].sort(), [".codex/hooks.json", ".codex/orchestra-v2-hook.mjs"].sort());
    const localFiles = [];
    const collect = (directory, prefix = "") => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const relative = join(prefix, entry.name).replaceAll("\\", "/");
        if (entry.isDirectory()) collect(join(directory, entry.name), relative);
        else localFiles.push(`.codex/${relative}`);
      }
    };
    collect(join(project, ".codex"));
    assert.deepEqual(localFiles.sort(), [".codex/hooks.json", ".codex/orchestra-v2-hook.mjs"].sort());
    const shim = readFileSync(join(project, ".codex/orchestra-v2-hook.mjs"), "utf8");
    assert.doesNotMatch(shim, /WorkLease|Work Lease|Reconciler|reconciler|policy|copied global core/i);
    assert.doesNotMatch(shim, /from\s+["'][^"']*(?:v2\/|core\/)/);
    assert.equal(shim.includes(JSON.stringify(resolve(orchestraHome))), true);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(global, { recursive: true, force: true });
  }
});

test("Codex v2 shim forwards stdin internally and projects SessionStart provider stdout", () => {
  const project = makeProject();
  const global = makeProject("orch-global-launcher-");
  const launcher = join(global, "cli.mjs");
  mkdirSync(project, { recursive: true });
  writeFileSync(launcher, `
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const payload = Buffer.concat(chunks).toString();
    if (process.argv.slice(2).join(" ") !== "provider codex hook") process.exit(9);
    process.stdout.write(JSON.stringify({
      ok: true,
      reason: "FORWARDED",
      forwarded: payload,
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "forwarded" },
    }));
  `);
  try {
    installCodexV2Shim({ targetDir: project, launcherPath: launcher });
    const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: "factual-id" });
    const output = execFileSync(process.execPath, [join(project, ".codex/orchestra-v2-hook.mjs")], {
      cwd: project,
      input,
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(output), {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "forwarded" },
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(global, { recursive: true, force: true });
  }
});

test("Codex v2 shim returns provider-safe fail-closed output for malformed or missing launcher", () => {
  const project = makeProject();
  const global = makeProject("orch-global-launcher-");
  const launcher = join(global, "cli.mjs");
  mkdirSync(project, { recursive: true });
  writeFileSync(launcher, "process.stdout.write('not-json');\n");
  try {
    installCodexV2Shim({ targetDir: project, launcherPath: launcher });
    const shim = join(project, ".codex/orchestra-v2-hook.mjs");
    const malformedResponses = [
      { hookEventName: "PreToolUse", response: "not-json" },
      { hookEventName: "PreToolUse", response: "{}" },
      {
        hookEventName: "PreToolUse",
        response: JSON.stringify({
          ok: true,
          reason: "ALLOW",
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "maybe" },
        }),
      },
      {
        hookEventName: "PreToolUse",
        response: JSON.stringify({
          ok: false,
          reason: "denied",
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
        }),
      },
      { hookEventName: "SessionStart", response: JSON.stringify({ ok: true, reason: null }) },
    ];
    for (const { hookEventName, response } of malformedResponses) {
      writeFileSync(launcher, `process.stdout.write(${JSON.stringify(response)});\n`);
      const result = spawnSync(process.execPath, [shim], {
        cwd: project,
        input: JSON.stringify({ hook_event_name: hookEventName }),
        encoding: "utf8",
      });
      const payload = JSON.parse(result.stdout);
      if (hookEventName === "PreToolUse") {
        assert.equal(result.status, 0);
        assert.deepEqual(payload, {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "ORCHESTRA_V2_GLOBAL_UNAVAILABLE",
          },
        });
      } else {
        assert.notEqual(result.status, 0);
        assert.deepEqual(payload, {});
      }
    }
    rmSync(launcher);
    const unavailable = spawnSync(process.execPath, [shim], {
      cwd: project,
      input: JSON.stringify({ hook_event_name: "PreToolUse" }),
      encoding: "utf8",
    });
    assert.equal(unavailable.status, 0);
    assert.deepEqual(JSON.parse(unavailable.stdout), {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "ORCHESTRA_V2_GLOBAL_UNAVAILABLE",
      },
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(global, { recursive: true, force: true });
  }
});

test("Codex v2 shim is additive and safely quotes Windows and POSIX launcher paths", () => {
  const v2Windows = buildCodexV2ShimArtifacts({
    launcherPath: "C:\\Program Files\\Orchestra\\cli.mjs",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    shimPath: "C:\\Project Space\\.codex\\orchestra-v2-hook.mjs",
  });
  const v2Posix = buildCodexV2ShimArtifacts({
    launcherPath: "/opt/Orchestra Tools/cli.mjs",
    nodePath: "/opt/Node Runtime/bin/node",
    shimPath: "/opt/Project Space/.codex/orchestra-v2-hook.mjs",
  });
  assert.match(v2Windows.hooksJson, /commandWindows/);
  assert.match(v2Windows.hooksJson, /Program Files/);
  assert.match(v2Posix.hooksJson, /command/);
  assert.match(v2Posix.hooksJson, /Project Space/);
  assert.match(v2Posix.shimSource, /Orchestra Tools/);

  const project = makeProject();
  const global = makeProject("orch-global-launcher-");
  const launcher = join(global, "cli.mjs");
  mkdirSync(project, { recursive: true });
  writeFileSync(launcher, "process.stdin.pipe(process.stdout);\n");
  mkdirSync(join(project, ".codex", "astra-orchestra"), { recursive: true });
  writeFileSync(join(project, ".codex", "astra-orchestra", "legacy.mjs"), "legacy\n");
  writeFileSync(join(project, ".codex", "orchestra-state.json"), "v1-state\n");
  writeFileSync(join(project, ".codex", "hooks.json"), JSON.stringify({
    hooks: {
      SessionStart: [{ matcher: ".*", hooks: [{ type: "command", command: "node .codex/astra-orchestra/session-hook.mjs" }] }],
      PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", commandWindows: "node .codex/astra-orchestra/session-hook.mjs" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "node .codex/astra-orchestra/session-hook.mjs" }, { type: "command", command: "user-hook" }] }],
    },
  }));
  try {
    installCodexV2Shim({ targetDir: project, launcherPath: launcher });
    assert.equal(readFileSync(join(project, ".codex/astra-orchestra/legacy.mjs"), "utf8"), "legacy\n");
    assert.equal(readFileSync(join(project, ".codex/orchestra-state.json"), "utf8"), "v1-state\n");
    const hooks = JSON.parse(readFileSync(join(project, ".codex/hooks.json"), "utf8")).hooks;
    assert.equal(hooks.SessionStart[0].hooks[0].command.includes("orchestra-v2-hook.mjs"), true);
    assert.equal(hooks.PreToolUse[0].hooks[0].commandWindows.includes("orchestra-v2-hook.mjs"), true);
    assert.equal(hooks.UserPromptSubmit.length, 1);
    assert.deepEqual(hooks.UserPromptSubmit[0].hooks, [{ type: "command", command: "user-hook" }]);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(global, { recursive: true, force: true });
  }
});


test("Codex metadata-only source version advance syncs without runtime replacement or backup", () => {
  const project = makeProject();
  const v1 = makeSource("1.0.0", "same-runtime");
  const v2 = makeSource("2.0.0", "same-runtime");
  try {
    installCodexProjectRuntime({ sourceRuntimeRoot: v1.runtime, targetDir: project });
    writeState(project, "DONE");

    const beforeManifest = buildCodexRuntimeManifest(project).hash;
    const dry = updateCodexProjectRuntime({ sourceRuntimeRoot: v2.runtime, targetDir: project, dryRun: true });
    assert.equal(dry.diff.clean, true);
    assert.equal(dry.metadataChanged, true);
    assert.equal(listCodexRuntimeBackups(project).length, 0);

    const result = updateCodexProjectRuntime({ sourceRuntimeRoot: v2.runtime, targetDir: project });
    assert.equal(result.operation, "metadata-sync");
    assert.equal(result.changed, true);
    assert.equal(result.runtimeChanged, false);
    assert.equal(result.metadataChanged, true);
    assert.equal(result.backup, undefined);
    assert.equal(buildCodexRuntimeManifest(project).hash, beforeManifest);
    assert.equal(listCodexRuntimeBackups(project).length, 0);

    const version = getCodexProjectRuntimeVersion(project);
    assert.equal(version.orchestraVersion, "2.0.0");
    assert.equal(version.lastOperation, "metadata-sync");

    const doctor = doctorCodexProjectRuntime({ targetDir: project, sourceRuntimeRoot: v2.runtime });
    assert.equal(doctor.healthy, true);
    assert.equal(doctor.sourceComparison.metadataVersionMatches, true);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(v1.root, { recursive: true, force: true });
    rmSync(v2.root, { recursive: true, force: true });
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

test("Codex INTAKE boundary state is quiescent for runtime maintenance", () => {
  const project = makeProject();
  try {
    installCodexProjectRuntime({ sourceRuntimeRoot: realSource, targetDir: project });
    writeState(project, "INTAKE");
    const quiescence = checkCodexRuntimeQuiescence(project);
    assert.equal(quiescence.safe, true);
    assert.equal(quiescence.reason, "QUIESCENT_INTAKE");
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
