const MANDATORY_FORBIDDEN = Object.freeze([".git/**", ".orchestra/state/**"]);
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const UNSUPPORTED_GLOB = /[?\[\]]/;

function invalid(code = "MUTATION_SCOPE_INVALID") {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function normalizePattern(value, { allowWildcard = true } = {}) {
  if (typeof value !== "string") invalid();
  let pattern = value;
  while (pattern.startsWith("./")) pattern = pattern.slice(2);

  if (!pattern
      || pattern.startsWith("/")
      || DRIVE_ABSOLUTE.test(pattern)
      || pattern.includes("\\")
      || pattern.includes("\0")
      || pattern.endsWith("/")) invalid();

  const segments = pattern.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) invalid();
  if (UNSUPPORTED_GLOB.test(pattern)) invalid();

  const starIndex = pattern.indexOf("*");
  if (starIndex === -1) return pattern;
  if (!allowWildcard) invalid();
  if (pattern === "**") return pattern;
  if (!pattern.endsWith("/**")) invalid();
  const base = pattern.slice(0, -3);
  if (!base || base.includes("*")) invalid();
  return pattern;
}

function normalizeList(values, { required = false } = {}) {
  if (!Array.isArray(values) || (required && values.length === 0)) invalid();
  const normalized = values.map((value) => normalizePattern(value));
  return [...new Set(normalized)].sort();
}

function matches(path, pattern) {
  if (pattern === "**") return true;
  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3);
    return path === base || path.startsWith(`${base}/`);
  }
  return path === pattern;
}

export function normalizeMutationPath(value) {
  return normalizePattern(value, { allowWildcard: false });
}

export function normalizeMutationScope({ allowedPaths, forbiddenPaths = [] } = {}) {
  const allowed = normalizeList(allowedPaths, { required: true });
  const forbidden = normalizeList([...forbiddenPaths, ...MANDATORY_FORBIDDEN]);
  return {
    allowedPaths: allowed,
    forbiddenPaths: forbidden,
  };
}

export function authorizeChangedPaths(changedPaths, normalizedScope) {
  if (!Array.isArray(changedPaths)
      || !normalizedScope
      || !Array.isArray(normalizedScope.allowedPaths)
      || !Array.isArray(normalizedScope.forbiddenPaths)) invalid();

  const violations = [];
  for (const value of changedPaths) {
    let path;
    try {
      path = normalizeMutationPath(value);
    } catch {
      violations.push(String(value));
      continue;
    }
    const allowed = normalizedScope.allowedPaths.some((pattern) => matches(path, pattern));
    const forbidden = normalizedScope.forbiddenPaths.some((pattern) => matches(path, pattern));
    if (!allowed || forbidden) violations.push(path);
  }

  const uniqueViolations = [...new Set(violations)].sort();
  return {
    allowed: uniqueViolations.length === 0,
    violations: uniqueViolations,
  };
}
