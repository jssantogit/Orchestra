import test from "node:test";
import assert from "node:assert/strict";

import { buildWorkerEnvelope } from "../../core/delegation/worker-envelope.mjs";

function request() {
  return {
    target: { logicalRole: "CRITICAL_REVIEWER" },
    purpose: "INDEPENDENT_REVIEW",
    packet: {
      goal: "review candidate",
      direction: { change: "inspect candidate", preserve: [] },
      anchors: [{ file: "src/example.mjs" }],
      scope: {
        allowedAreas: ["src/**", "./.orchestra/state/**", ".orchestra\\state\\delegations\\**"],
        forbidden: ["secrets/**", "./.orchestra/state/private/**"],
      },
      permissions: { discovery: "DIRECTED", tests: "READ_ONLY" },
      validation: ["focused tests"],
    },
    authority: { capabilities: ["LOCAL_READ", "PROCESS_EXEC"] },
    limits: { timeoutMs: 120000, maxOutputBytes: 65536 },
  };
}

test("Worker Envelope normalizes canonical state paths out of allowed scope and keeps explicit internal prohibitions", () => {
  const envelope = buildWorkerEnvelope(request());

  assert.deepEqual(envelope.scope.allowedAreas, ["src/**"]);
  assert.ok(envelope.scope.forbidden.includes("secrets/**"));
  assert.ok(envelope.scope.forbidden.includes(".orchestra/state/**"));
  assert.ok(envelope.scope.forbidden.includes(".git/**"));
  assert.equal(envelope.scope.forbidden.some((entry) => entry.includes("\\")), false);
  assert.equal(envelope.scope.forbidden.some((entry) => entry.startsWith("./")), false);
});
