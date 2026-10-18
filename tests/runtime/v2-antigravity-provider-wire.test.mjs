import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { renderAntigravityV2Shim } from "../../v2/providers/antigravity/shim-template.mjs";

for (const eventName of ["SessionStart", "PreInvocation", "PreToolUse", "PostToolUse"]) {
  for (const ok of [true, false]) {
    test(`Antigravity provider wire closes ${eventName} ${ok ? "success" : "denial"} without internal metadata`, async () => {
      const root = await mkdtemp(join(tmpdir(), "orchestra-agy-wire-"));
      try {
        const launcherPath = join(root, "launcher.mjs");
        const response = {
          ok, reason: ok ? null : "SESSION_RUNTIME_STALE", projectId: "private-project",
          operation: { operationId: "private-operation" },
          ...(eventName !== "PostToolUse" ? { hookSpecificOutput: {
            hookEventName: eventName,
            ...(eventName === "PreToolUse"
              ? { permissionDecision: ok ? "allow" : "deny", permissionDecisionReason: "private diagnostic" }
              : { additionalContext: "private context" }),
          } } : {}),
        };
        await writeFile(launcherPath, `process.stdout.write(${JSON.stringify(JSON.stringify(response))});process.exitCode=${ok ? 0 : 1};`);
        const shimPath = join(root, "shim.mjs");
        await writeFile(shimPath, renderAntigravityV2Shim({ launcherPath }));
        const result = spawnSync(process.execPath, [shimPath], {
          input: JSON.stringify({ hookEventName: eventName, conversationId: "factual-actor" }), encoding: "utf8",
        });
        const expected = eventName === "PreToolUse"
          ? ok ? { decision: "allow" } : { decision: "deny", reason: "SESSION_RUNTIME_STALE" }
          : eventName === "PostToolUse" ? {} : { injectSteps: [] };
        assert.deepEqual(JSON.parse(result.stdout), expected);
        assert.equal(result.status, eventName === "PreToolUse" || ok ? 0 : 1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

for (const invalid of [null, {}, { ok: true }, { ok: false, reason: "DENIED", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }]) {
  test(`Antigravity provider wire fails closed for invalid global envelope ${JSON.stringify(invalid)}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestra-agy-wire-invalid-"));
    try {
      const launcherPath = join(root, "launcher.mjs");
      await writeFile(launcherPath, `process.stdout.write(${JSON.stringify(JSON.stringify(invalid))});`);
      const shimPath = join(root, "shim.mjs");
      await writeFile(shimPath, renderAntigravityV2Shim({ launcherPath }));
      for (const missing of [false, true]) {
        if (missing) await rm(launcherPath);
        const result = spawnSync(process.execPath, [shimPath], {
          input: JSON.stringify({ hookEventName: "PreToolUse", conversationId: "factual-actor" }), encoding: "utf8",
        });
        assert.equal(result.status, 0);
        assert.deepEqual(JSON.parse(result.stdout), { decision: "deny", reason: "ORCHESTRA_V2_GLOBAL_UNAVAILABLE" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("Antigravity configured native hook slot rejects contradictory payload events before global handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-agy-slot-"));
  try {
    const launcherPath = join(root, "launcher.mjs");
    await writeFile(launcherPath, 'process.stdout.write(JSON.stringify({ok:true,reason:null,hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow"}}));');
    const shimPath = join(root, "shim.mjs");
    await writeFile(shimPath, renderAntigravityV2Shim({ launcherPath }));
    const result = spawnSync(process.execPath, [shimPath, "--event", "PreToolUse"], {
      input: JSON.stringify({ hookEventName: "PostToolUse", conversationId: "factual-actor" }), encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { decision: "deny", reason: "ORCHESTRA_V2_GLOBAL_UNAVAILABLE" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
