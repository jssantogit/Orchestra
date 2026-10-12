export const LAB_AUTHORITY = "NONE";

export const LAB_ALLOWED_OPERATIONS = new Set([
  "OBSERVE",
  "ANALYZE",
  "STORE_LAB_ARTIFACT",
  "READ_SHADOW_RESULT",
]);

export function isLabOperationAllowed(operation) {
  return LAB_ALLOWED_OPERATIONS.has(String(operation || ""));
}

export function assertLabOperationAllowed(operation) {
  const normalized = String(operation || "");
  if (isLabOperationAllowed(normalized)) return normalized;
  const error = new Error(`LAB_AUTHORITY_DENIED:${normalized || "UNKNOWN"}`);
  error.code = "LAB_AUTHORITY_DENIED";
  error.operation = normalized;
  error.authority = LAB_AUTHORITY;
  throw error;
}
