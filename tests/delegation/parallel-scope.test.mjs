import test from "node:test";
import assert from "node:assert/strict";

import {
  assessChangedPathIndependence,
  assessParallelScopeIndependence,
} from "../../core/delegation/parallel-scope.mjs";

function scope(allowedPaths, forbiddenPaths = []) {
  return { allowedPaths, forbiddenPaths };
}

test("parallel scopes accept provably disjoint exact files and subtrees", () => {
  for (const [left, right] of [
    [scope(["app/home/**"]), scope(["app/library/**"])],
    [scope(["src/a.kt"]), scope(["src/b.kt"])],
    [scope(["app/detail/**"]), scope(["domain/metadata/**"])],
  ]) {
    assert.deepEqual(assessParallelScopeIndependence(left, right), {
      independent: true,
      overlaps: [],
    });
  }
});

test("parallel scopes reject parent-child, exact-subtree, wildcard, and normalized overlap", () => {
  const cases = [
    [scope(["app/**"]), scope(["app/src/**"])],
    [scope(["src/a.kt"]), scope(["src/**"])],
    [scope(["**"]), scope(["elsewhere/**"])],
    [scope(["./app/home/**"]), scope(["app/home/**"])],
    [scope(["app/home/file.kt"]), scope(["app/home/file.kt"])],
  ];

  for (const [left, right] of cases) {
    const result = assessParallelScopeIndependence(left, right);
    assert.equal(result.independent, false);
    assert.ok(result.overlaps.length > 0);
    assert.deepEqual([...result.overlaps].sort(), result.overlaps);
  }
});

test("parallel scope proof fails closed on invalid traversal or absolute patterns", () => {
  for (const invalid of ["../escape/**", "/absolute/**", "C:/absolute/**"]) {
    assert.throws(
      () => assessParallelScopeIndependence(scope([invalid]), scope(["safe/**"])),
      { code: "MUTATION_SCOPE_INVALID" },
    );
  }
});

test("factual changed-path independence rejects exact intersections and normalizes duplicates", () => {
  assert.deepEqual(
    assessChangedPathIndependence(
      ["app/home/A.kt", "app/home/A.kt", "app/home/B.kt"],
      ["app/library/C.kt"],
    ),
    { independent: true, overlaps: [] },
  );

  assert.deepEqual(
    assessChangedPathIndependence(
      ["app/home/B.kt", "app/home/A.kt", "app/home/A.kt"],
      ["app/home/A.kt", "app/home/B.kt", "app/home/B.kt"],
    ),
    { independent: false, overlaps: ["app/home/A.kt", "app/home/B.kt"] },
  );
});

test("factual changed-path proof fails closed on non-repository paths", () => {
  for (const invalid of ["../escape.kt", "/absolute.kt", "C:/absolute.kt", "dir/**"]) {
    assert.throws(
      () => assessChangedPathIndependence([invalid], ["safe/file.kt"]),
      { code: "MUTATION_SCOPE_INVALID" },
    );
  }
});
