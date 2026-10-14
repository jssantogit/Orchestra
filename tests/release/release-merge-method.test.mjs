import test from "node:test";
import assert from "node:assert/strict";

import { validatePublishAuthorization } from "../../scripts/release/publish-guard.mjs";

function matchingReleasePr() {
  return [{
    number: 42,
    merged_at: "2026-10-14T19:00:00Z",
    merge_commit_sha: "deadbeef",
    base: { ref: "main" },
    head: { ref: "release/v1.1.0" },
  }];
}

test("publish guard rejects a single-parent release integration even when PR and SHA match", () => {
  const result = validatePublishAuthorization({
    version: "1.1.0",
    sha: "deadbeef",
    ciConclusion: "success",
    parentCount: 1,
    pullRequests: matchingReleasePr(),
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /merge commit/i);
});

test("publish guard accepts a two-parent release merge commit when all other evidence matches", () => {
  const result = validatePublishAuthorization({
    version: "1.1.0",
    sha: "deadbeef",
    ciConclusion: "success",
    parentCount: 2,
    pullRequests: matchingReleasePr(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.tag, "v1.1.0");
});
