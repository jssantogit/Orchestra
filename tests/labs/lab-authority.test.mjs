import test from "node:test";
import assert from "node:assert/strict";

import {
  LAB_AUTHORITY,
  LAB_ALLOWED_OPERATIONS,
  assertLabOperationAllowed,
  isLabOperationAllowed,
} from "../../labs/lab-authority.mjs";

const DENIED = [
  "ACCEPT_WORK",
  "GRANT_CAPABILITY",
  "CLAIM_WORK_LEASE",
  "MUTATE_PRODUCT",
  "PROMOTE_EVIDENCE",
];

const ALLOWED = [
  "OBSERVE",
  "ANALYZE",
  "STORE_LAB_ARTIFACT",
  "READ_SHADOW_RESULT",
];

test("Labs are explicit zero-authority components", () => {
  assert.equal(LAB_AUTHORITY, "NONE");
});

test("Labs allow only bounded observational operations", () => {
  for (const operation of ALLOWED) {
    assert.equal(isLabOperationAllowed(operation), true, operation);
    assert.equal(assertLabOperationAllowed(operation), operation);
    assert.equal(LAB_ALLOWED_OPERATIONS.has(operation), true);
  }
});

test("Labs cannot accept work, grant capability, claim leases, mutate product, or promote evidence", () => {
  for (const operation of DENIED) {
    assert.equal(isLabOperationAllowed(operation), false, operation);
    assert.throws(
      () => assertLabOperationAllowed(operation),
      (error) => error?.code === "LAB_AUTHORITY_DENIED" && error?.operation === operation,
    );
  }
});

test("unknown lab operations fail closed", () => {
  assert.equal(isLabOperationAllowed("SOMETHING_NEW"), false);
  assert.throws(() => assertLabOperationAllowed("SOMETHING_NEW"), /LAB_AUTHORITY_DENIED/);
});
