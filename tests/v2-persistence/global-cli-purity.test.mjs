import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "v2", "global", "cli.mjs");

async function withSandbox(fn) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-global-cli-purity-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runCli({ home, cwd, args }) {
  return spawnSync(process.execPath, [cli, ...args, "--home", home], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

async function assertMissing(path) {
  await assert.rejects(access(path), (error) => error?.code === "ENOENT");
}

test("unknown command is rejected before creating global persistence", async () => {
  await withSandbox(async (root) => {
    const home = join(root, "home");
    const result = runCli({ home, cwd: root, args: ["unknown-command"] });

    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr).code, "ORCHESTRA_V2_CLI_USAGE");
    await assertMissing(home);
  });
});

test("invalid register options are rejected before creating global persistence", async () => {
  await withSandbox(async (root) => {
    const home = join(root, "home");
    const result = runCli({
      home,
      cwd: root,
      args: ["register", "--instruction-epoch", "not-an-integer", "--trust", "trusted"],
    });

    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr).code, "ORCHESTRA_V2_CLI_USAGE");
    await assertMissing(home);
  });
});
