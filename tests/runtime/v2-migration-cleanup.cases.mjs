import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";

const nodeMajor = Number(process.versions.node.split(".")[0]);
const v2Only = { skip: nodeMajor < 24 };

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-migration-cleanup-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeJson(path, value) {
  await mkdir(path.slice(0, path.lastIndexOf(process.platform === "win32" ? "\\" : "/")), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function initGit(workspace) {
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
}

function captureStream() {
  let body = "";
  return {
    stream: { write(chunk) { body += String(chunk); } },
    json() { return body.trim() ? JSON.parse(body.trim()) : null; },
  };
}

async function runCli({ argv, cwd, env = {}, stdin = Readable.from([]) }) {
  const { runGlobalCli } = await import("../../v2/global/cli.mjs");
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await runGlobalCli({ argv, cwd, env, stdin, stdout: stdout.stream, stderr: stderr.stream });
  return { exitCode, stdout: stdout.json(), stderr: stderr.json() };
}

async function prepareMigration(root, name) {
  const workspace = join(root, name);
  await mkdir(workspace, { recursive: true });
  await initGit(workspace);

  const codexRuntime = join(workspace, ".codex", "astra-orchestra", "runtime", "orchestra-v2-runtime.json");
  const antigravityRuntime = join(workspace, ".agents", "orchestra-runtime.json");
  const privateArtifact = join(workspace, ".orchestra", "state", "delegation", "artifacts", "private-1", "result.json");
  const codexUserFile = join(workspace, ".codex", "notes.txt");
  const antigravityUserFile = join(workspace, ".agents", "personal.txt");

  await writeJson(codexRuntime, {
    schema: "orchestra.runtime-manifest.v1",
    version: 1,
    provider: "codex",
  });
  await writeJson(antigravityRuntime, {
    schema: "orchestra.runtime-manifest.v1",
    version: 1,
    provider: "antigravity",
  });
  await writeJson(privateArtifact, {
    schema: "orchestra.delegation-artifact.v1",
    prompt: "private migration fixture",
    source: "private migration bytes",
  });
  await writeFile(codexUserFile, "user-owned codex data\n", "utf8");
  await writeFile(antigravityUserFile, "user-owned antigravity data\n", "utf8");

  const home = join(root, `${name}-home`);
  const applied = await runCli({
    argv: ["project", "migrate", "apply", workspace, "--command-id", `apply-${name}`, "--home", home],
    cwd: workspace,
  });
  assert.equal(applied.exitCode, 0);
  assert.equal(applied.stdout.ok, true);

  return {
    workspace,
    home,
    projectId: applied.stdout.project.projectId,
    codexRuntime,
    antigravityRuntime,
    privateArtifact,
    codexUserFile,
    antigravityUserFile,
  };
}

async function activateMigration(root, fixture) {
  const launcherDir = join(root, "global-engine");
  await mkdir(launcherDir, { recursive: true });
  const launcherPath = join(launcherDir, "orchestra.mjs");
  await writeFile(launcherPath, "// global launcher fixture\n", "utf8");

  const { createGlobalProjectRegistry } = await import("../../v2/global/project-registry.mjs");
  const { createMigrationLifecycleStore } = await import("../../v2/migration/rollback.mjs");
  const { createMigrationShimActivator } = await import("../../v2/migration/shim-activation.mjs");
  const { installCodexV2Shim } = await import("../../v2/providers/codex/shim-manager.mjs");
  const { installAntigravityV2Shim } = await import("../../v2/providers/antigravity/shim-manager.mjs");

  const registry = createGlobalProjectRegistry({ home: fixture.home });
  try {
    const lifecycleStore = createMigrationLifecycleStore({ home: fixture.home, state: registry.state });
    const activator = createMigrationShimActivator({
      registry,
      lifecycleStore,
      home: fixture.home,
      launcherPath,
      nodePath: process.execPath,
      codexInstaller: installCodexV2Shim,
      antigravityInstaller: installAntigravityV2Shim,
      verify: async () => ({
        ok: true,
        mode: "V2_GLOBAL",
        fallbackUsed: false,
        globalStatus: { ok: true },
        providers: {
          codex: { sessionStart: true, attached: true },
          antigravity: { sessionStart: true, attached: true },
        },
        recovery: { ok: true },
      }),
    });
    const activated = await activator.activate({
      projectId: fixture.projectId,
      providers: ["codex", "antigravity"],
    });
    assert.equal(activated.ok, true);
    assert.equal(activated.cleanupEligible, true);
    return activated;
  } finally {
    registry.close();
  }
}

async function assertMissing(path) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

test("migration cleanup is unavailable until factual v2 activation is verified", v2Only, async () => {
  await withRoot(async (root) => {
    const fixture = await prepareMigration(root, "not-verified");
    const result = await runCli({
      argv: ["project", "migrate", "cleanup", fixture.projectId, "--command-id", "cleanup-not-verified", "--home", fixture.home],
      cwd: fixture.workspace,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout.ok, false);
    assert.equal(result.stdout.code, "MIGRATION_CLEANUP_NOT_VERIFIED");
    assert.equal(await lstat(fixture.codexRuntime).then((stat) => stat.isFile()), true);
  });
});

test("migration cleanup blocks changed and newly-unrecognized managed runtime files before deleting anything", v2Only, async () => {
  await withRoot(async (root) => {
    const changed = await prepareMigration(root, "changed-managed");
    await activateMigration(root, changed);
    await writeFile(changed.codexRuntime, "changed after inventory\n", "utf8");

    const changedResult = await runCli({
      argv: ["project", "migrate", "cleanup", changed.projectId, "--command-id", "cleanup-changed", "--home", changed.home],
      cwd: changed.workspace,
    });
    assert.equal(changedResult.exitCode, 1);
    assert.equal(changedResult.stdout.code, "MIGRATION_CLEANUP_BLOCKED");
    assert.equal(changedResult.stdout.reason, "MIGRATION_MANAGED_FILE_CHANGED");
    assert.equal(await lstat(changed.antigravityRuntime).then((stat) => stat.isFile()), true);

    const extra = await prepareMigration(root, "extra-managed");
    await activateMigration(root, extra);
    const unrecognized = join(extra.workspace, ".codex", "astra-orchestra", "unexpected-local-runtime.txt");
    await writeFile(unrecognized, "not inventoried\n", "utf8");

    const extraResult = await runCli({
      argv: ["project", "migrate", "cleanup", extra.projectId, "--command-id", "cleanup-extra", "--home", extra.home],
      cwd: extra.workspace,
    });
    assert.equal(extraResult.exitCode, 1);
    assert.equal(extraResult.stdout.code, "MIGRATION_CLEANUP_BLOCKED");
    assert.equal(extraResult.stdout.reason, "MIGRATION_UNRECOGNIZED_MANAGED_FILE");
    assert.equal(await lstat(extra.codexRuntime).then((stat) => stat.isFile()), true);
  });
});

test("migration cleanup blocks symlink or junction egress under an inventoried managed runtime root", v2Only, async () => {
  await withRoot(async (root) => {
    const fixture = await prepareMigration(root, "egress");
    await activateMigration(root, fixture);
    const outside = join(root, "outside-managed-target");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "outside.txt"), "must survive\n", "utf8");
    const escape = join(fixture.workspace, ".codex", "astra-orchestra", "escape");
    await symlink(outside, escape, process.platform === "win32" ? "junction" : "dir");

    const result = await runCli({
      argv: ["project", "migrate", "cleanup", fixture.projectId, "--command-id", "cleanup-egress", "--home", fixture.home],
      cwd: fixture.workspace,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout.code, "MIGRATION_CLEANUP_BLOCKED");
    assert.equal(result.stdout.reason, "MIGRATION_PATH_ESCAPE_BLOCKED");
    assert.equal(await readFile(join(outside, "outside.txt"), "utf8"), "must survive\n");
    assert.equal(await lstat(fixture.codexRuntime).then((stat) => stat.isFile()), true);
  });
});

test("verified cleanup removes only inventoried runtime copies, replays idempotently, and v2 attach still works", v2Only, async () => {
  await withRoot(async (root) => {
    const fixture = await prepareMigration(root, "cleanup-success");
    await activateMigration(root, fixture);
    const argv = ["project", "migrate", "cleanup", fixture.projectId, "--command-id", "cleanup-success", "--home", fixture.home];

    const first = await runCli({ argv, cwd: fixture.workspace });
    const replay = await runCli({ argv, cwd: fixture.workspace });

    assert.equal(first.exitCode, 0);
    assert.equal(first.stdout.ok, true);
    assert.equal(first.stdout.code, "MIGRATION_CLEANUP_COMPLETE");
    assert.equal(first.stdout.replayed, false);
    assert.equal(replay.exitCode, 0);
    assert.equal(replay.stdout.replayed, true);
    await assertMissing(fixture.codexRuntime);
    await assertMissing(fixture.antigravityRuntime);

    assert.equal(await readFile(fixture.privateArtifact, "utf8").then((text) => text.includes("private migration fixture")), true);
    assert.equal(await readFile(fixture.codexUserFile, "utf8"), "user-owned codex data\n");
    assert.equal(await readFile(fixture.antigravityUserFile, "utf8"), "user-owned antigravity data\n");
    for (const shim of [
      ".codex/hooks.json",
      ".codex/orchestra-v2-hook.mjs",
      ".agents/hooks.json",
      ".agents/orchestra-v2-hook.mjs",
    ]) {
      assert.equal(await lstat(join(fixture.workspace, ...shim.split("/"))).then((stat) => stat.isFile()), true);
    }

    const attach = await runCli({
      argv: ["provider", "codex", "hook", "--home", fixture.home],
      cwd: fixture.workspace,
      stdin: Readable.from([JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "cleanup-provider-session",
        cwd: fixture.workspace,
      })]),
    });
    assert.equal(attach.exitCode, 0);
    assert.equal(attach.stdout.ok, true);
    assert.equal(attach.stdout.projectId, fixture.projectId);
  });
});
