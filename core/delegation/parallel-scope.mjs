import {
  normalizeMutationPath,
  normalizeMutationScope,
} from "./mutation-scope.mjs";

function overlap(left, right) {
  if (left === "**" || right === "**") return true;

  const leftTree = left.endsWith("/**");
  const rightTree = right.endsWith("/**");
  const leftBase = leftTree ? left.slice(0, -3) : left;
  const rightBase = rightTree ? right.slice(0, -3) : right;

  if (!leftTree && !rightTree) return leftBase === rightBase;
  if (leftTree && rightTree) {
    return leftBase === rightBase
      || leftBase.startsWith(`${rightBase}/`)
      || rightBase.startsWith(`${leftBase}/`);
  }
  if (leftTree) return rightBase === leftBase || rightBase.startsWith(`${leftBase}/`);
  return leftBase === rightBase || leftBase.startsWith(`${rightBase}/`);
}

function normalizedChangedPaths(paths) {
  if (!Array.isArray(paths)) {
    const error = new Error("MUTATION_SCOPE_INVALID");
    error.code = "MUTATION_SCOPE_INVALID";
    throw error;
  }
  return [...new Set(paths.map((path) => normalizeMutationPath(path)))].sort();
}

export function assessParallelScopeIndependence(leftScope, rightScope) {
  const left = normalizeMutationScope(leftScope);
  const right = normalizeMutationScope(rightScope);
  const overlaps = [];

  for (const leftPattern of left.allowedPaths) {
    for (const rightPattern of right.allowedPaths) {
      if (overlap(leftPattern, rightPattern)) {
        overlaps.push(`${leftPattern} <> ${rightPattern}`);
      }
    }
  }

  const normalizedOverlaps = [...new Set(overlaps)].sort();
  return {
    independent: normalizedOverlaps.length === 0,
    overlaps: normalizedOverlaps,
  };
}

export function assessChangedPathIndependence(leftPaths, rightPaths) {
  const left = normalizedChangedPaths(leftPaths);
  const right = new Set(normalizedChangedPaths(rightPaths));
  const overlaps = left.filter((path) => right.has(path));
  return {
    independent: overlaps.length === 0,
    overlaps,
  };
}
