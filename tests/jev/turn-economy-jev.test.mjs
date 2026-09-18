import test from "node:test";
import assert from "node:assert/strict";

import { createFakeJevClient } from "../../experiments/jev/client.mjs";
import {
  JEV_TURN_ECONOMY_CASES,
  runJevTurnEconomyEvaluation,
} from "../../benchmarks/turn-economy/jev-evaluation.mjs";

test("Jev counterfactual suite covers every Turn Economy task category", async () => {
  const client = createFakeJevClient(({ projection, name }) => {
    const candidateId = name.split("__")[1] || "";
    const candidate = projection.candidates.find((item) => item.id === candidateId);
    if (!candidate) return 0.5;
    if (name.startsWith("duplicate__")) return candidate.tags?.includes("redundant") ? 0.9 : 0.1;
    if (candidate.pinned) return 0.99;
    if (candidate.tags?.some((tag) => ["test", "parser", "formatter", "security"].includes(tag))) return 0.85;
    return 0.2;
  });
  const result = await runJevTurnEconomyEvaluation({ client, live: true });
  assert.equal(result.authority, "NONE");
  assert.deepEqual(
    result.cases.map((item) => item.task_category).sort(),
    ["critical", "investigation", "lookup", "multi", "simple", "status"],
  );
  assert.equal(result.cases.length, JEV_TURN_ECONOMY_CASES.length);
  assert.equal(result.aggregate.jev_calls, 6);
  assert.equal(result.aggregate.critical_reference_recall, 1);
  assert.ok(result.aggregate.future_use_recall_at_k >= 0.8);
});
