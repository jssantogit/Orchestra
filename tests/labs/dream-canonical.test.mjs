import test from "node:test";
import assert from "node:assert/strict";

import { canonicalize, sha256Canonical } from "../../labs/dream/runtime/canonical.mjs";
import { DREAM_SCHEMAS, createDreamEvent } from "../../labs/dream/runtime/records.mjs";
import { LAB_AUTHORITY, assertLabOperationAllowed } from "../../labs/lab-authority.mjs";

test("canonical Dream Lab source is loadable outside the provider runtime tree", () => {
  assert.equal(LAB_AUTHORITY, "NONE");
  assert.equal(canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.match(sha256Canonical({ dream: "lab" }), /^[a-f0-9]{64}$/);
  const event = createDreamEvent({
    schema: DREAM_SCHEMAS.EVENT,
    eventType: "LAB_SMOKE",
    payload: { observational: true },
  });
  assert.equal(event.schema, DREAM_SCHEMAS.EVENT);
});

test("Dream Lab canonical source remains observational under the shared Lab authority boundary", () => {
  assert.equal(assertLabOperationAllowed("OBSERVE"), "OBSERVE");
  assert.throws(
    () => assertLabOperationAllowed("ACCEPT_WORK"),
    (error) => error?.code === "LAB_AUTHORITY_DENIED" && error?.authority === "NONE",
  );
});
