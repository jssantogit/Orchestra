export function authorizeTestMutation({ packet, testPath, changeKind } = {}) {
  if (packet?.permissions?.tests !== "MODIFY_AUTHORIZED_TARGETS") {
    return Object.freeze({ allowed: false, reason: "TEST_MUTATION_READ_ONLY" });
  }

  const target = typeof testPath === "string" ? testPath.trim() : "";
  const allowed = Array.isArray(packet?.scope?.allowedAreas) ? packet.scope.allowedAreas : [];
  const forbidden = Array.isArray(packet?.scope?.forbidden) ? packet.scope.forbidden : [];

  if (!target || forbidden.includes(target) || !allowed.includes(target)) {
    return Object.freeze({ allowed: false, reason: "TEST_TARGET_NOT_AUTHORIZED" });
  }

  if (changeKind !== "REGRESSION_TEST") {
    return Object.freeze({ allowed: false, reason: "TEST_CHANGE_NOT_AUTHORIZED" });
  }

  return Object.freeze({ allowed: true, reason: "AUTHORIZED_REGRESSION_TARGET" });
}
