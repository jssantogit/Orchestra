import test from "node:test";
import assert from "node:assert/strict";

import { evaluateRankingAgainstFutureUse } from "../../experiments/jev/future-use-oracle.mjs";
import { evaluateForRetrievalAssist } from "../../experiments/jev/evaluator.mjs";

test("future-use oracle measures false-low and critical recall from later factual references", () => {
  const candidates = [
    { id: "a", evidence_id: "ev-a", pinned: true },
    { id: "b", relative_path: "src/parser.js", pinned: false },
    { id: "c", execution_id: "exec-c", pinned: false },
  ];
  const ranking = {
    items: [
      { id: "a", semantic_score: 0.9 },
      { id: "b", semantic_score: 0.1 },
      { id: "c", semantic_score: 0.8 },
    ],
  };
  const result = evaluateRankingAgainstFutureUse({
    candidates,
    ranking,
    selectedIds: ["a", "c"],
    futureEvents: [
      { type: "EVIDENCE_USED", evidenceId: "ev-a" },
      { type: "RETRY", path: "src/parser.js" },
    ],
    criticalIds: ["a"],
  });
  assert.equal(result.critical_reference_recall, 1);
  assert.equal(result.future_use_recall_at_k, 0.5);
  assert.equal(result.false_low_relevance, 0.5);
});

test("promotion evaluator fails closed on insufficient samples and regressions", () => {
  const report = evaluateForRetrievalAssist([{
    task_category: "lookup",
    potential_context_reduction: 0.8,
    future_use_recall_at_k: 1,
    critical_reference_recall: 1,
  }]);
  assert.equal(report.eligible_for_retrieval_assist, false);
  assert.ok(report.violations.includes("INSUFFICIENT_SAMPLES"));
  assert.ok(report.violations.includes("INSUFFICIENT_TASK_COVERAGE"));
});
