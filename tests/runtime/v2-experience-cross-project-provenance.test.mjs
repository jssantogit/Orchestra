import test from "node:test";
import assert from "node:assert/strict";

import { toCrossProjectExperience } from "../../v2/experience/contracts.mjs";
import { projectExperience } from "../../v2/experience/projector.mjs";

test("cross-project Experience exposes lineage diversity, not raw source lineage provenance", () => {
  const projected = projectExperience({
    category: "DIAGNOSTIC",
    sourceProjectId: "prj-private-b",
    sourceLineageId: "lineage-private-b",
    workId: "work-private-b",
    operationId: "op-private-b",
    domainCohort: "software-engineering",
    facts: { failureClass: "OWNER_TERMINATED" },
    outcome: { terminalOutcome: "RECOVERED", success: true },
    projectLineageIds: ["lineage-private-b", "lineage-independent"],
    requestedScope: "GLOBAL_CANDIDATE",
    projectionVersion: "1",
  });
  assert.equal(projected.valid, true, JSON.stringify(projected.errors));

  const publicRecord = toCrossProjectExperience(projected.experience);
  assert.equal(publicRecord.generalization.projectLineageCount, 2);
  assert.equal(publicRecord.source?.projectId, undefined);
  assert.equal(publicRecord.source?.lineageId, undefined);
  assert.equal(publicRecord.source?.workId, undefined);
  assert.equal(publicRecord.source?.operationId, undefined);
  assert.equal(JSON.stringify(publicRecord).includes("lineage-private-b"), false);
});
