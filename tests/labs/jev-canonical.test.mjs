import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { JEV_AUTHORITY, JEV_SCHEMAS } from "../../labs/jev/schemas.mjs";
import { projectForJev } from "../../labs/jev/outbound-projector.mjs";
import { evaluateLiveEgress } from "../../labs/jev/egress-policy.mjs";


test("canonical Jev Lab path preserves zero authority", () => {
  assert.equal(JEV_AUTHORITY, "NONE");
  const projection = projectForJev({ goal: "phase-5-lab-smoke", candidates: [] });
  assert.equal(projection.authority, "NONE");
  assert.equal(projection.schema, JEV_SCHEMAS.PROJECTION);
});

test("canonical Jev Lab remains fail-closed for live project egress", () => {
  const result = evaluateLiveEgress({
    projectRoot: "/tmp/private-project",
    live: true,
    env: {},
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "JEV_PROJECT_EGRESS_REQUIRES_EXPLICIT_OPT_IN");
});

test("synthetic fixture exemption follows physical paths and denies symlink escape", () => {
  const fixtureRoot = fileURLToPath(new URL("../../benchmarks/turn-economy/fixture/", import.meta.url));
  mkdirSync(fixtureRoot, { recursive: true });
  const outside = mkdtempSync(join(tmpdir(), "orchestra-jev-egress-outside-"));
  const link = join(fixtureRoot, `.jev-egress-link-${process.pid}-${Date.now()}`);
  try {
    symlinkSync(outside, link, "dir");
    const result = evaluateLiveEgress({ projectRoot: link, live: true, env: {} });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "JEV_PROJECT_EGRESS_REQUIRES_EXPLICIT_OPT_IN");
  } finally {
    rmSync(link, { force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
