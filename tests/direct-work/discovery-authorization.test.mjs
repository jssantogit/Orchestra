import test from "node:test";
import assert from "node:assert/strict";

import {
  DISCOVERY_OPERATIONS,
  authorizeDiscovery,
} from "../../core/policy/discovery-authorization.mjs";
import { DISCOVERY_MODES } from "../../core/domain/implementation-packet.mjs";

const anchors = Object.freeze([
  { path: "src/formatter.js", symbol: "formatNumber", exactText: "toFixed", testHint: "formatter precision" },
]);

function decide(operation, target, relation, mode = DISCOVERY_MODES.DIRECTED) {
  return authorizeDiscovery({ mode, operation, target, anchors, relation });
}

test("DIRECTED permits exact anchor lookups and local windows tied to anchors", () => {
  assert.equal(decide(DISCOVERY_OPERATIONS.EXACT_SYMBOL, "formatNumber", "ANCHOR_SYMBOL").allowed, true);
  assert.equal(decide(DISCOVERY_OPERATIONS.NARROW_FILE_PATTERN, "src/formatter.js", "ANCHOR_PATH").allowed, true);
  assert.equal(decide(DISCOVERY_OPERATIONS.EXACT_TEXT, "toFixed", "ANCHOR_TEXT").allowed, true);
  assert.equal(decide(DISCOVERY_OPERATIONS.LOCAL_WINDOW, "src/formatter.js", "ANCHOR_LOCAL_WINDOW").allowed, true);
});

test("DIRECTED permits direct references and matching-test lookup when related to an anchor", () => {
  assert.equal(decide(DISCOVERY_OPERATIONS.DIRECT_REFERENCE, "src/format-options.js", "DIRECT_REFERENCE").allowed, true);
  assert.equal(decide(DISCOVERY_OPERATIONS.MATCHING_TEST, "test/formatter.test.js", "MATCHING_TEST").allowed, true);
});

test("DIRECTED denies broad search, architecture exploration, unrelated alternatives, and git history", () => {
  for (const [operation, relation] of [
    [DISCOVERY_OPERATIONS.BROAD_SEARCH, "ANCHOR_SYMBOL"],
    [DISCOVERY_OPERATIONS.ARCHITECTURE_EXPLORE, "ARCHITECTURE_CONTEXT"],
    [DISCOVERY_OPERATIONS.BROAD_SEARCH, "ALTERNATIVE_SOLUTION"],
    [DISCOVERY_OPERATIONS.GIT_HISTORY, "ANCHOR_PATH"],
  ]) {
    const decision = decide(operation, "repository", relation);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "DISCOVERY_NOT_AUTHORIZED");
  }
});

test("DIRECTED may use a separately authorized broad operation only with an explicit policy grant", () => {
  const denied = decide(DISCOVERY_OPERATIONS.GIT_HISTORY, "src/formatter.js", "ANCHOR_PATH");
  assert.equal(denied.allowed, false);

  const granted = decide(DISCOVERY_OPERATIONS.GIT_HISTORY, "src/formatter.js", "EXPLICIT_POLICY_GRANT");
  assert.deepEqual(granted, { allowed: true, reason: "EXPLICIT_POLICY_GRANT" });
});

test("NONE allows only declared-target/local-context inspection and denies discovery expansion", () => {
  assert.deepEqual(decide(
    DISCOVERY_OPERATIONS.LOCAL_WINDOW,
    "src/formatter.js",
    "DECLARED_TARGET",
    DISCOVERY_MODES.NONE,
  ), { allowed: true, reason: "DECLARED_LOCAL_CONTEXT" });

  for (const operation of [
    DISCOVERY_OPERATIONS.EXACT_SYMBOL,
    DISCOVERY_OPERATIONS.MATCHING_TEST,
    DISCOVERY_OPERATIONS.DIRECT_REFERENCE,
    DISCOVERY_OPERATIONS.BROAD_SEARCH,
  ]) {
    assert.equal(decide(operation, "other", "ANCHOR_SYMBOL", DISCOVERY_MODES.NONE).allowed, false);
  }
});

test("DIRECTED fails closed when the claimed anchor relation does not match the target", () => {
  assert.deepEqual(decide(DISCOVERY_OPERATIONS.EXACT_SYMBOL, "unrelatedSymbol", "ANCHOR_SYMBOL"), {
    allowed: false,
    reason: "ANCHOR_RELATION_NOT_PROVEN",
  });
  assert.deepEqual(decide(DISCOVERY_OPERATIONS.EXACT_TEXT, "unrelated text", "ANCHOR_TEXT"), {
    allowed: false,
    reason: "ANCHOR_RELATION_NOT_PROVEN",
  });
  assert.deepEqual(decide(DISCOVERY_OPERATIONS.NARROW_FILE_PATTERN, "src/other.js", "ANCHOR_PATH"), {
    allowed: false,
    reason: "ANCHOR_RELATION_NOT_PROVEN",
  });
});

test("INVESTIGATIVE is explicit and never inferred from unknown modes or relations", () => {
  assert.deepEqual(authorizeDiscovery({
    mode: "UNKNOWN",
    operation: DISCOVERY_OPERATIONS.BROAD_SEARCH,
    target: "repository",
    anchors,
    relation: "EXPLICIT_POLICY_GRANT",
  }), { allowed: false, reason: "DISCOVERY_MODE_INVALID" });

  assert.deepEqual(decide(
    DISCOVERY_OPERATIONS.ARCHITECTURE_EXPLORE,
    "repository",
    "INVESTIGATIVE_SCOPE",
    DISCOVERY_MODES.INVESTIGATIVE,
  ), { allowed: true, reason: "INVESTIGATIVE_AUTHORIZED" });
});
