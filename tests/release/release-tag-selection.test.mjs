import test from "node:test";
import assert from "node:assert/strict";

import { selectLatestStableTag } from "../../scripts/release/versioning.mjs";

test("latest release tag selection ignores prereleases and uses semantic ordering", () => {
  assert.equal(selectLatestStableTag([
    "v1.0.9",
    "v1.0.10",
    "v1.1.0-rc.1",
    "v1.0.2",
    "not-a-release",
  ]), "v1.0.10");

  assert.equal(selectLatestStableTag(["v1.9.9", "v2.0.0", "v10.0.0", "v2.10.0"]), "v10.0.0");
  assert.throws(() => selectLatestStableTag(["v1.1.0-rc.1", "junk"]), /No stable release tag/);
});
