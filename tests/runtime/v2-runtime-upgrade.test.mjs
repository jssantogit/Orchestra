import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MINIMUM_NODE_MAJOR = 24;
const currentNodeMajor = Number(process.versions.node.split(".")[0]);

if (currentNodeMajor < MINIMUM_NODE_MAJOR) {
  test("runtime lifecycle suite rejects unsupported Node before SQLite", () => {
    const launcherPath = fileURLToPath(new URL("../../v2/global/orchestra.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [launcherPath, "runtime", "list"], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).code, "ORCHESTRA_V2_RUNTIME_UNSUPPORTED");
  });
} else {
  await import("./v2-runtime-upgrade.cases.mjs");
}
