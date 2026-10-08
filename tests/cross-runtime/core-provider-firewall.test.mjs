import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { runContaminationCheck } from "../../scripts/contamination-check.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function withFixture(files, fn) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-core-firewall-"));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = join(root, relativePath);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, content, "utf8");
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function coreViolations(root) {
  return runContaminationCheck(root).filter((item) => item.runtime === "CORE");
}

test("core firewall: canonical core may use provider-neutral Node and domain vocabulary", () => {
  withFixture({
    "core/domain/example.mjs": [
      'import { createHash } from "node:crypto";',
      'export function actorKey(actorId) { return createHash("sha256").update(actorId).digest("hex"); }',
    ].join("\n"),
  }, (root) => {
    assert.deepEqual(coreViolations(root), []);
  });
});

test("core firewall: canonical core rejects provider runtime imports", () => {
  withFixture({
    "core/domain/bad.mjs": 'import "../../runtimes/codex/.codex/astra-orchestra/routing-policy.mjs";\n',
  }, (root) => {
    const violations = coreViolations(root);
    assert.equal(violations.length, 1);
    assert.match(violations[0].violation, /provider runtime/i);
  });
});

test("core firewall: canonical core rejects concrete provider model IDs", () => {
  withFixture({
    "core/domain/bad-model.mjs": 'export const selectedModel = "gpt-6-sol";\n',
  }, (root) => {
    const violations = coreViolations(root);
    assert.equal(violations.length, 1);
    assert.match(violations[0].violation, /model/i);
  });
});

test("core firewall: canonical core rejects provider session and hook vocabulary", () => {
  withFixture({
    "core/domain/bad-session.mjs": 'export const session_id = "provider-session";\n',
    "core/domain/bad-hook.mjs": 'export const hookPhase = "PreToolUse";\n',
  }, (root) => {
    const violations = coreViolations(root);
    assert.equal(violations.length, 2);
    assert.ok(violations.some((item) => /session/i.test(item.violation)));
    assert.ok(violations.some((item) => /hook/i.test(item.violation)));
  });
});

test("core firewall: provider runtimes may depend one-way on generated local core", () => {
  withFixture({
    "runtimes/codex/.codex/astra-orchestra/adapter.mjs": 'export * from "./core/domain/candidate.mjs";\n',
    "runtimes/antigravity/.agents/skills/orchestra/adapter.mjs": 'export * from "./core/domain/candidate.mjs";\n',
  }, (root) => {
    assert.deepEqual(runContaminationCheck(root), []);
  });
});

test("core firewall: repository canonical core is provider-neutral", () => {
  assert.deepEqual(coreViolations(repositoryRoot), []);
});
