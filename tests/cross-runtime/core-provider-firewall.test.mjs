import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runContaminationCheck } from "../../scripts/contamination-check.mjs";

function withFixture(files, callback) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-core-firewall-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    }
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("live canonical Core and both generated runtime mirrors pass through the contamination gate", () => {
  const violations = runContaminationCheck();
  assert.deepEqual(violations.filter(({ runtime }) => runtime === "CORE"), []);
});

test("contamination gate rejects provider leakage from canonical schemas", () => {
  withFixture({
    "schemas/runtime-leak.schema.json": '{"model":"gemini-3.8-flash-low","event":"hook_event_name","sessionField":"session_id"}\n',
  }, (root) => {
    const violations = runContaminationCheck(root).filter(({ runtime }) => runtime === "CORE");
    assert.ok(violations.length >= 3, JSON.stringify(violations, null, 2));
    assert.ok(violations.some(({ file }) => file === "schemas/runtime-leak.schema.json"));
  });
});

test("contamination gate rejects runtime imports and provider-to-provider coupling in Core", () => {
  withFixture({
    "core/domain/from-codex.mjs": 'import "../../runtimes/codex/.codex/api.mjs";\n',
    "core/schema/generated/from-antigravity.mjs": 'export { hook } from "../../../runtimes/antigravity/.agents/hook.mjs";\n',
    "core/domain/cross-provider.mjs": 'const runtime = "codex + antigravity";\n',
  }, (root) => {
    const violations = runContaminationCheck(root).filter(({ runtime }) => runtime === "CORE");
    assert.ok(violations.length >= 3);
    for (const file of ["from-codex.mjs", "from-antigravity.mjs", "cross-provider.mjs"]) {
      assert.ok(violations.some((violation) => violation.file.endsWith(file)), `expected a Core firewall finding for ${file}`);
    }
  });
});

test("contamination gate rejects concrete provider models and runtime hook/session payload assumptions", () => {
  withFixture({
    "core/domain/model.mjs": 'export const model = "gpt-6-sol";\n',
    "core/domain/codex-session.mjs": 'const payload = { hook_event_name: "PreToolUse", session_id: "abc" };\n',
    "core/schema/generated/agy-session.mjs": 'export const state = { antigravitySessionId: "abc", geminiModel: "gemini-3.8-flash-low" };\n',
  }, (root) => {
    const violations = runContaminationCheck(root).filter(({ runtime }) => runtime === "CORE");
    assert.ok(violations.length >= 5, JSON.stringify(violations, null, 2));
    assert.ok(violations.some(({ file, violation }) => file.includes("generated/agy-session") && /model|session|provider/i.test(violation)));
  });
});

test("provider model and hook/session leakage is rejected in each runtime-local Core mirror", () => {
  withFixture({
    "runtimes/codex/.codex/astra-orchestra/core/schema/generated/provider-leak.mjs": 'export const route = { model: "gpt-6-sol", hook_event_name: "SessionStart" };\n',
    "runtimes/antigravity/.agents/skills/orchestra/core/schema/generated/provider-leak.mjs": 'export const route = { model: "gemini-3.8-flash-low", session_id: "runtime-session" };\n',
  }, (root) => {
    const violations = runContaminationCheck(root).filter(({ runtime }) => runtime === "CORE");
    for (const path of ["runtimes/codex/.codex/astra-orchestra/core/", "runtimes/antigravity/.agents/skills/orchestra/core/"]) {
      assert.ok(violations.some(({ file }) => file.startsWith(path)), `expected a firewall finding under ${path}`);
    }
  });
});

test("generic Core provenance and role fields remain allowed", () => {
  withFixture({
    "core/domain/neutral-contract.mjs": `export const record = {
      provider: "runtime-neutral provider identifier",
      sessionIdHash: "sha256:opaque",
      conversationId: "runtime-neutral-conversation",
      role: "WORKER",
      model: "unspecified",
      source: { provider: "build system", reference: "run-123" },
    };\n`,
    "core/schema/generated/neutral-contract.mjs": 'export const roles = ["CONTROL", "WORKER", "REVIEWER"];\n',
  }, (root) => {
    const violations = runContaminationCheck(root).filter(({ runtime }) => runtime === "CORE");
    assert.deepEqual(violations, []);
  });
});

test("provider runtimes cannot import each other through static, side-effect, dynamic, or re-export forms", () => {
  withFixture({
    "runtimes/codex/nested/codex.mjs": `
      import value from "../../antigravity/.agents/value.mjs";
      import "../../antigravity/.agents/side-effect.mjs";
      const lazy = import("../../antigravity/.agents/lazy.mjs");
      const required = require("../../antigravity/.agents/required.cjs");
      import {
        multiline,
      } from "../../antigravity/.agents/multiline.mjs";
      const multilineLazy = import(
        "../../antigravity/.agents/multiline-lazy.mjs"
      );
    `,
    "runtimes/antigravity/agy.mjs": `
      export { route } from "../codex/.codex/route.mjs";
      const lazy = import("../codex/.codex/lazy.mjs");
    `,
  }, (root) => {
    const violations = runContaminationCheck(root);
    assert.equal(violations.filter(({ runtime }) => runtime === "CODEX").length, 6);
    assert.equal(violations.filter(({ runtime }) => runtime === "ANTIGRAVITY").length, 2);
    assert.ok(violations.some(({ file, line }) => file.endsWith("codex.mjs") && line === 6));
    assert.ok(violations.some(({ file, line }) => file.endsWith("codex.mjs") && line === 9));
  });
});
