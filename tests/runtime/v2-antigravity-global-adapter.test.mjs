import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MINIMUM_NODE_MAJOR = 24;
const currentNodeMajor = Number(process.versions.node.split(".")[0]);

if (currentNodeMajor < MINIMUM_NODE_MAJOR) {
  test("Antigravity v2 global launcher rejects Node 20 before loading SQLite", () => {
    const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
    const launcherPath = fileURLToPath(new URL("../../v2/global/orchestra.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [launcherPath, "home"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      code: "ORCHESTRA_V2_RUNTIME_UNSUPPORTED",
      message: "Orchestra v2 requires Node.js 24 or newer",
      currentNode: process.versions.node,
      minimumNodeMajor: MINIMUM_NODE_MAJOR,
    });
  });
} else {
  await import("./v2-antigravity-hook-schema.cases.mjs");
  await import("./v2-antigravity-global-adapter.cases.mjs");
}
