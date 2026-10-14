import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("prepare workflow builds runtimes before checking current-main release readiness", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const workflow = readFileSync(join(root, ".github/workflows/prepare-release.yml"), "utf8");
  const readinessMarker = "- name: Verify current main release metadata";
  const readinessIndex = workflow.indexOf(readinessMarker);
  const buildIndex = workflow.indexOf("npm run build:runtimes");

  assert.notEqual(readinessIndex, -1, "prepare workflow must keep the current-main readiness gate");
  assert.notEqual(buildIndex, -1, "prepare workflow must build runtimes before readiness can inspect dist/runtime");
  assert.ok(
    buildIndex < readinessIndex,
    "prepare workflow must build dist/runtime before the initial release:readiness check",
  );
});
