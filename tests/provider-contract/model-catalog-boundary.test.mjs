import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  scanCoreProviderFirewall,
  scanProviderRuntimeImports,
} from "../../scripts/contamination-check.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function fixture() {
  return mkdtempSync(join(tmpdir(), "orch-provider-catalog-boundary-"));
}

function put(root, path, content) {
  const target = join(root, path);
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, content, "utf8");
}

test("real core remains free of concrete provider models and provider runtime assumptions", () => {
  assert.deepEqual(scanCoreProviderFirewall(repoRoot), []);
});

test("core logical-role vocabulary is permitted while concrete model SKUs fail the firewall", () => {
  const root = fixture();
  try {
    put(root, "core/domain/logical-role.mjs", 'export const ROLE = "IMPLEMENTER";\n');
    assert.deepEqual(scanCoreProviderFirewall(root), []);

    put(root, "core/domain/forbidden-model.mjs", 'export const MODEL = "gpt-6-luna";\nexport const OTHER = "gemini-3.8-flash-medium";\n');
    const violations = scanCoreProviderFirewall(root);
    assert.equal(violations.length, 2);
    assert.ok(violations.every((item) => item.violation === "Concrete provider model identifier in Core"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical provider source is firewall-scanned just like runtime provider source", () => {
  const root = fixture();
  try {
    put(root, "providers/codex/model-catalog.mjs", 'import "../antigravity/model-catalog.mjs";\n');
    put(root, "providers/antigravity/model-catalog.mjs", 'export const MODEL = "gemini-3.8-flash-medium";\n');

    const violations = scanProviderRuntimeImports(root);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].runtime, "CODEX");
    assert.match(violations[0].file, /^providers[\\/]codex[\\/]/);
    assert.match(violations[0].violation, /Provider source import of ANTIGRAVITY provider/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider catalogs may own concrete model SKUs without contaminating core", () => {
  const root = fixture();
  try {
    put(root, "core/domain/logical-role.mjs", 'export const ROLE = "CONTROL";\n');
    put(root, "providers/codex/model-catalog.mjs", 'export const MODEL = "gpt-6-sol";\n');
    put(root, "providers/antigravity/model-catalog.mjs", 'export const MODEL = "gemini-3.8-flash-medium";\n');
    assert.deepEqual(scanCoreProviderFirewall(root), []);
    assert.deepEqual(scanProviderRuntimeImports(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
