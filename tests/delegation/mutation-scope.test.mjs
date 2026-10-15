import test from "node:test";
import assert from "node:assert/strict";

const scopeModule = await import("../../core/delegation/mutation-scope.mjs");
const { normalizeMutationScope, authorizeChangedPaths } = scopeModule;

test("mutation scope normalizes exact paths, subtree paths, and whole-product wildcard", () => {
  assert.deepEqual(normalizeMutationScope({
    allowedPaths: ["./src/file.mjs", "src/**", "**", "src/**"],
    forbiddenPaths: ["./secrets/**"],
  }), {
    allowedPaths: ["**", "src/**", "src/file.mjs"],
    forbiddenPaths: [".git/**", ".orchestra/state/**", "secrets/**"],
  });
});

test("mutation scope rejects unsafe and unsupported path syntax", () => {
  for (const invalid of [
    "",
    "/absolute/path",
    "C:/absolute/path",
    "C:\\absolute\\path",
    "../escape",
    "src/../escape",
    "src/*",
    "src/**/nested",
    "src/file?.mjs",
    "src/[ab].mjs",
  ]) {
    assert.throws(
      () => normalizeMutationScope({ allowedPaths: [invalid], forbiddenPaths: [] }),
      /MUTATION_SCOPE/,
      invalid,
    );
  }
});

test("mandatory forbidden scope always wins over broad allowed scope", () => {
  const scope = normalizeMutationScope({ allowedPaths: ["**"], forbiddenPaths: [] });
  assert.deepEqual(authorizeChangedPaths([
    "src/example.mjs",
    ".git/config",
    ".orchestra/state/delegation/artifacts/x/manifest.json",
  ], scope), {
    allowed: false,
    violations: [".git/config", ".orchestra/state/delegation/artifacts/x/manifest.json"],
  });
});

test("subtree matching respects path boundaries and exact paths stay exact", () => {
  const scope = normalizeMutationScope({
    allowedPaths: ["src/**", "README.md"],
    forbiddenPaths: ["src/private/**"],
  });

  assert.deepEqual(authorizeChangedPaths(["src/a.mjs", "README.md"], scope), {
    allowed: true,
    violations: [],
  });
  assert.deepEqual(authorizeChangedPaths(["src2/a.mjs", "README.md.bak"], scope), {
    allowed: false,
    violations: ["README.md.bak", "src2/a.mjs"],
  });
  assert.deepEqual(authorizeChangedPaths(["src/private/key.txt"], scope), {
    allowed: false,
    violations: ["src/private/key.txt"],
  });
});
