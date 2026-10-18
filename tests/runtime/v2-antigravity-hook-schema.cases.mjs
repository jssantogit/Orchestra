import test from "node:test";
import assert from "node:assert/strict";

import { buildAntigravityV2ShimArtifacts } from "../../v2/providers/antigravity/shim-manager.mjs";

test("Antigravity SessionStart uses the provider lifecycle handler shape while tool hooks keep matcher groups", () => {
  const artifacts = buildAntigravityV2ShimArtifacts({
    launcherPath: "/global/orchestra.mjs",
    nodePath: "/global/node",
    shimPath: "/workspace/.agents/orchestra-v2-hook.mjs",
  });
  const group = JSON.parse(artifacts.hooksJson)["orchestra-v2-global"];

  assert.deepEqual(group.SessionStart, [{
    type: "command",
    command: artifacts.command,
    commandWindows: artifacts.commandWindows,
    timeout: 10,
  }]);

  for (const eventName of ["PreToolUse", "PostToolUse"]) {
    assert.deepEqual(group[eventName], [{
      matcher: "*",
      hooks: [{
        type: "command",
        command: artifacts.command,
        commandWindows: artifacts.commandWindows,
        timeout: 10,
      }],
    }]);
  }
});
