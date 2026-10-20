import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const nodeMajor = Number(process.versions.node.split(".")[0]);
const v2Only = { skip: nodeMajor < 24 };

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-migration-integration-rollback-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeJson(path, value) {
  await mkdir(join(path, ".."), { recursive: true }).catch(async () => {
    const { dirname } = await import("node:path");
    await mkdir(dirname(path), { recursive: true });
  });
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

async function runCli({ argv, cwd, env = {} }) {
  const { runGlobalCli } = await import("../../v2/global/cli.mjs");
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await runGlobalCli({ argv, cwd, env, stdout: stdout.stream, stderr: stderr.stream });
  return { exitCode, stdout: stdout.json(), stderr: stderr.json() };
}

async function assertMissing(path) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

async function prepareCodexMigration(root, name) {
  const workspace = join(root, name);
  await mkdir(workspace, { recursive: true });
  await initGit(workspace);
  const runtimePath = join(workspace, ".codex", "astra-orchestra", "runtime", "orchestra-v2-runtime.json");
  const hooksPath = join(workspace, ".codex", "hooks.json");
  const shimPath = join(workspace, ".codex", "orchestra-v2-hook.mjs");
  await writeJson(runtimePath, {
    schema: "orchestra.runtime-manifest.v1",
    version: 1,
    provider: "codex",
  });
  const legacyHooks = `${JSON.stringify({
    description: "legacy v1 hooks",
    hooks: {
      SessionStart: [{
        matcher: "startup|resume|clear|compact",
        hooks: [{
          type: "command",
          command: "node .codex/astra-orchestra/session-hook.mjs",
          commandWindows: "node .codex/astra-orchestra/session-hook.mjs",
        }],
      }],
      PostToolUse: [{
        matcher: ".*",
        hooks: [{
          type: "command",
          command: "node .codex/astra-orchestra/session-post-tool-hook.mjs",
          commandWindows: "node .codex/astra-orchestra/session-post-tool-hook.mjs",
        }],
      }],
    },
  }, null, 2)}\n`;
  await writeFile(hooksPath, legacyHooks, "utf8");
  const home = join(root, `${name}-home`);
  const applied = await runCli({
    argv: ["project", "migrate", "apply", workspace, "--command-id", `apply-${name}`, "--home", home],
    cwd: workspace,
  });
  assert.equal(applied.exitCode, 0);
  assert.equal(applied.stdout.ok, true);
  const launcherDir = join(root, `${name}-global-engine`);
  await mkdir(launcherDir, { recursive: true });
  const launcherPath = join(launcherDir, "orchestra.mjs");
  await writeFile(launcherPath, "// global launcher fixture\n", "utf8");
  return {
    workspace,
    home,
    runtimePath,
    hooksPath,
    shimPath,
    legacyHooks,
    launcherPath,
    projectId: applied.stdout.project.projectId,
  };
}

async function activateCodex(fixture, verify) {
  const { createGlobalProjectRegistry } = await import("../../v2/global/project-registry.mjs");
  const { createMigrationLifecycleStore } = await import("../../v2/migration/rollback.mjs");
  const { createMigrationShimActivator } = await import("../../v2/migration/shim-activation.mjs");
  const { installCodexV2Shim } = await import("../../v2/providers/codex/shim-manager.mjs");
  const registry = createGlobalProjectRegistry({ home: fixture.home });
  try {
    const lifecycleStore = createMigrationLifecycleStore({ home: fixture.home, state: registry.state });
    const activator = createMigrationShimActivator({
      registry,
      lifecycleStore,
      home: fixture.home,
      launcherPath: fixture.launcherPath,
      nodePath: process.execPath,
      codexInstaller: installCodexV2Shim,
      antigravityInstaller: async () => ({ ok: true, files: [] }),
      verify,
    });
    return await activator.activate({ projectId: fixture.projectId, providers: ["codex"] });
  } finally {
    registry.close();
  }
}

function successfulVerification() {
  return {
    ok: true,
    mode: "V2_GLOBAL",
    fallbackUsed: false,
    globalStatus: { ok: true },
    providers: { codex: { sessionStart: true, attached: true } },
    recovery: { ok: true },
  };
}

test("failed migration activation restores the exact pre-activation Codex integration", v2Only, async () => {
  await withRoot(async (root) => {
    const fixture = await prepareCodexMigration(root, "failed-activation");
    const result = await activateCodex(fixture, async () => ({
      ok: false,
      mode: "V2_GLOBAL",
      fallbackUsed: false,
    }));

    assert.equal(result.ok, false);
    assert.equal(result.code, "MIGRATION_V2_VERIFICATION_FAILED");
    assert.equal(await readFile(fixture.hooksPath, "utf8"), fixture.legacyHooks);
    await assertMissing(fixture.shimPath);
    assert.equal(await lstat(fixture.runtimePath).then((stat) => stat.isFile()), true);
  });
});

test("official migration rollback restores pre-activation provider integration after successful v2 activation", v2Only, async () => {
  await withRoot(async (root) => {
    const fixture = await prepareCodexMigration(root, "explicit-rollback");
    const activated = await activateCodex(fixture, async () => successfulVerification());
    assert.equal(activated.ok, true);
    assert.notEqual(await readFile(fixture.hooksPath, "utf8"), fixture.legacyHooks);
    assert.equal(await lstat(fixture.shimPath).then((stat) => stat.isFile()), true);

    const rolled = await runCli({
      argv: ["project", "migrate", "rollback", fixture.projectId, "--command-id", "rollback-integration", "--home", fixture.home],
      cwd: fixture.workspace,
    });

    assert.equal(rolled.exitCode, 0);
    assert.equal(rolled.stdout.ok, true);
    assert.equal(rolled.stdout.manifest.status, "ROLLED_BACK");
    assert.equal(await readFile(fixture.hooksPath, "utf8"), fixture.legacyHooks);
    await assertMissing(fixture.shimPath);
    assert.equal(await lstat(fixture.runtimePath).then((stat) => stat.isFile()), true);
  });
});
