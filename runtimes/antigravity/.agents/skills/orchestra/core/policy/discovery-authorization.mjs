import { DISCOVERY_MODES } from "../domain/implementation-packet.mjs";

export const DISCOVERY_OPERATIONS = Object.freeze({
  EXACT_SYMBOL: "EXACT_SYMBOL",
  NARROW_FILE_PATTERN: "NARROW_FILE_PATTERN",
  EXACT_TEXT: "EXACT_TEXT",
  DIRECT_REFERENCE: "DIRECT_REFERENCE",
  MATCHING_TEST: "MATCHING_TEST",
  LOCAL_WINDOW: "LOCAL_WINDOW",
  BROAD_SEARCH: "BROAD_SEARCH",
  GIT_HISTORY: "GIT_HISTORY",
  ARCHITECTURE_EXPLORE: "ARCHITECTURE_EXPLORE",
});

const VALID_MODES = new Set(Object.values(DISCOVERY_MODES));
const VALID_OPERATIONS = new Set(Object.values(DISCOVERY_OPERATIONS));
const BROAD_OPERATIONS = new Set([
  DISCOVERY_OPERATIONS.BROAD_SEARCH,
  DISCOVERY_OPERATIONS.GIT_HISTORY,
  DISCOVERY_OPERATIONS.ARCHITECTURE_EXPLORE,
]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function targetMatchesAnchor(operation, target, anchors) {
  const wanted = text(target);
  if (!wanted) return false;
  const list = Array.isArray(anchors) ? anchors : [];

  switch (operation) {
    case DISCOVERY_OPERATIONS.EXACT_SYMBOL:
      return list.some((anchor) => text(anchor?.symbol) === wanted);
    case DISCOVERY_OPERATIONS.NARROW_FILE_PATTERN:
    case DISCOVERY_OPERATIONS.LOCAL_WINDOW:
      return list.some((anchor) => text(anchor?.path) === wanted);
    case DISCOVERY_OPERATIONS.EXACT_TEXT:
      return list.some((anchor) => text(anchor?.exactText) === wanted);
    default:
      return false;
  }
}

function hasAnchorRelation(relation, anchors) {
  const list = Array.isArray(anchors) ? anchors : [];
  if (!list.length) return false;
  if (relation === "DIRECT_REFERENCE") return true;
  if (relation === "MATCHING_TEST") return list.some((anchor) => text(anchor?.testHint));
  return false;
}

export function authorizeDiscovery({
  mode,
  operation,
  target,
  anchors = [],
  relation,
} = {}) {
  if (!VALID_MODES.has(mode)) {
    return Object.freeze({ allowed: false, reason: "DISCOVERY_MODE_INVALID" });
  }
  if (!VALID_OPERATIONS.has(operation)) {
    return Object.freeze({ allowed: false, reason: "DISCOVERY_OPERATION_INVALID" });
  }

  if (mode === DISCOVERY_MODES.INVESTIGATIVE) {
    if (relation === "INVESTIGATIVE_SCOPE" || relation === "EXPLICIT_POLICY_GRANT") {
      return Object.freeze({ allowed: true, reason: "INVESTIGATIVE_AUTHORIZED" });
    }
    return Object.freeze({ allowed: false, reason: "DISCOVERY_NOT_AUTHORIZED" });
  }

  if (mode === DISCOVERY_MODES.NONE) {
    const declaredLocalContext = (
      relation === "DECLARED_TARGET" &&
      [DISCOVERY_OPERATIONS.LOCAL_WINDOW, DISCOVERY_OPERATIONS.NARROW_FILE_PATTERN].includes(operation) &&
      targetMatchesAnchor(operation, target, anchors)
    );
    return Object.freeze(declaredLocalContext
      ? { allowed: true, reason: "DECLARED_LOCAL_CONTEXT" }
      : { allowed: false, reason: "DISCOVERY_NOT_AUTHORIZED" });
  }

  if (relation === "EXPLICIT_POLICY_GRANT" && BROAD_OPERATIONS.has(operation)) {
    return Object.freeze({ allowed: true, reason: "EXPLICIT_POLICY_GRANT" });
  }

  if (BROAD_OPERATIONS.has(operation) || relation === "ALTERNATIVE_SOLUTION") {
    return Object.freeze({ allowed: false, reason: "DISCOVERY_NOT_AUTHORIZED" });
  }

  const anchored = (
    (operation === DISCOVERY_OPERATIONS.EXACT_SYMBOL && relation === "ANCHOR_SYMBOL" && targetMatchesAnchor(operation, target, anchors)) ||
    (operation === DISCOVERY_OPERATIONS.NARROW_FILE_PATTERN && relation === "ANCHOR_PATH" && targetMatchesAnchor(operation, target, anchors)) ||
    (operation === DISCOVERY_OPERATIONS.EXACT_TEXT && relation === "ANCHOR_TEXT" && targetMatchesAnchor(operation, target, anchors)) ||
    (operation === DISCOVERY_OPERATIONS.LOCAL_WINDOW && relation === "ANCHOR_LOCAL_WINDOW" && targetMatchesAnchor(operation, target, anchors)) ||
    (operation === DISCOVERY_OPERATIONS.DIRECT_REFERENCE && relation === "DIRECT_REFERENCE" && hasAnchorRelation(relation, anchors) && Boolean(text(target))) ||
    (operation === DISCOVERY_OPERATIONS.MATCHING_TEST && relation === "MATCHING_TEST" && hasAnchorRelation(relation, anchors) && Boolean(text(target)))
  );

  if (!anchored) {
    return Object.freeze({ allowed: false, reason: "ANCHOR_RELATION_NOT_PROVEN" });
  }

  return Object.freeze({ allowed: true, reason: "DIRECTED_DISCOVERY_AUTHORIZED" });
}
