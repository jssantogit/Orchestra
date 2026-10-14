import test from "node:test";
import assert from "node:assert/strict";

import { evaluateExistingPublication } from "../../scripts/release/publish-guard.mjs";

test("published release no-op verifies the tag still points to the release integration SHA", () => {
  assert.deepEqual(evaluateExistingPublication({
    sha: "later-main-sha",
    tagSha: "release-integration-sha",
    releaseExists: true,
    releaseSha: "release-integration-sha",
  }), {
    action: "noop",
    tagExists: true,
    releaseExists: true,
    reason: "already-published",
  });

  const movedTag = evaluateExistingPublication({
    sha: "later-main-sha",
    tagSha: "moved-tag-sha",
    releaseExists: true,
    releaseSha: "release-integration-sha",
  });
  assert.equal(movedTag.action, "fail");
  assert.match(movedTag.reason, /published tag.*release integration SHA/i);
});
