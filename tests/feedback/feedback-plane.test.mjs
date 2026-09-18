import test from "node:test";
import assert from "node:assert/strict";
import {
  FEEDBACK_STATUS,
  applyFeedbackDeclarations,
  extractFeedbackDeclarations,
  feedbackSummary,
  reconcileFeedbackPlane,
} from "../../runtimes/antigravity/.agents/skills/orchestra/feedback-plane.mjs";

function baseState() {
  return {
    taskId: "task-feedback",
    attempt: 0,
    mutationSeq: 2,
    evidenceLedger: [],
  };
}

const actor = {
  actorId: "child-1",
  role: "WORKER",
  source: "RUNTIME_IDENTITY",
  confidence: "HIGH",
  taskId: "task-feedback",
  attempt: 0,
  mutationSeq: 2,
};

test("feedback plane parses compact model declarations but does not treat them as evidence", () => {
  const state = baseState();
  const message = [
    'ORCHESTRA_FEEDBACK_V1: {"type":"HYPOTHESIS","key":"h1","statement":"normalization causes the failure","falsifier":"same failure occurs with normalization bypassed"}',
    'ORCHESTRA_FEEDBACK_V1: {"type":"EXPERIMENT","key":"e1","hypothesis_key":"h1","command":"node --test test/focused.test.js","design":"OBSERVATIONAL","pass_interpretation":"FALSIFIES","fail_interpretation":"SUPPORTS"}',
  ].join("\n");

  const parsed = extractFeedbackDeclarations(message);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.declarations.length, 2);
  applyFeedbackDeclarations(state, parsed.declarations, actor);
  reconcileFeedbackPlane(state);

  assert.equal(state.feedbackPlane.hypotheses.length, 1);
  assert.equal(state.feedbackPlane.experiments.length, 1);
  assert.equal(state.feedbackPlane.observations.length, 0);
  assert.equal(state.feedbackPlane.feedback[0].status, FEEDBACK_STATUS.UNKNOWN);
});

test("factual Evidence Ledger execution deterministically supports or falsifies a hypothesis", () => {
  const state = baseState();
  applyFeedbackDeclarations(state, [
    { type: "HYPOTHESIS", key: "h1", statement: "parser boundary is wrong", falsifier: "focused reproduction passes unchanged" },
    { type: "EXPERIMENT", key: "e1", hypothesis_key: "h1", command: "node --test test/focused.test.js", pass_interpretation: "FALSIFIES", fail_interpretation: "SUPPORTS" },
  ], actor);

  state.evidenceLedger.push({
    executionId: "exec-red",
    command: "node --test test/focused.test.js",
    exitCode: 1,
    mutationSeq: 2,
    attempt: 0,
    confidence: "HIGH",
    actorRole: "WORKER",
  });

  reconcileFeedbackPlane(state);
  assert.equal(state.feedbackPlane.observations.length, 1);
  assert.equal(state.feedbackPlane.feedback[0].status, FEEDBACK_STATUS.SUPPORTED);

  state.evidenceLedger.push({
    executionId: "exec-green-same-seq",
    command: "node --test test/focused.test.js",
    exitCode: 0,
    mutationSeq: 2,
    attempt: 0,
    confidence: "HIGH",
    actorRole: "WORKER",
  });
  reconcileFeedbackPlane(state);
  assert.equal(state.feedbackPlane.feedback[0].status, FEEDBACK_STATUS.FALSIFIED);
});

test("CAUSALLY_VERIFIED requires exact same factual command failing before and passing after a mutation", () => {
  const state = baseState();
  applyFeedbackDeclarations(state, [
    { type: "HYPOTHESIS", key: "h1", statement: "the scoped mutation fixes the observed failure", falsifier: "post-mutation command still fails" },
    {
      type: "EXPERIMENT",
      key: "ab",
      hypothesis_key: "h1",
      command: "node --test test/focused.test.js",
      design: "MUTATION_AB",
      pass_interpretation: "SUPPORTS",
      fail_interpretation: "SUPPORTS",
    },
  ], actor);

  state.evidenceLedger.push(
    { executionId: "exec-before", command: "node --test test/focused.test.js", exitCode: 1, mutationSeq: 1, attempt: 0, confidence: "HIGH" },
    { executionId: "exec-after", command: "node --test test/focused.test.js", exitCode: 0, mutationSeq: 2, attempt: 0, confidence: "HIGH" },
  );

  reconcileFeedbackPlane(state);
  assert.equal(state.feedbackPlane.feedback[0].status, FEEDBACK_STATUS.CAUSALLY_VERIFIED);
  assert.ok(state.feedbackPlane.feedback[0].causal_pair);
});

test("model-only, low-confidence, unknown, or cross-attempt records cannot produce factual feedback", () => {
  const state = baseState();
  applyFeedbackDeclarations(state, [
    { type: "HYPOTHESIS", key: "h1", statement: "some claim", falsifier: "test" },
    { type: "EXPERIMENT", key: "e1", hypothesis_key: "h1", command: "pnpm test", fail_interpretation: "SUPPORTS" },
  ], actor);

  state.evidenceLedger.push(
    { executionId: "low", command: "pnpm test", exitCode: 1, mutationSeq: 2, attempt: 0, confidence: "LOW" },
    { executionId: "other-attempt", command: "pnpm test", exitCode: 1, mutationSeq: 2, attempt: 1, confidence: "HIGH" },
    { executionId: "unknown", command: "pnpm test", mutationSeq: 2, attempt: 0, confidence: "HIGH" },
  );

  reconcileFeedbackPlane(state);
  assert.equal(state.feedbackPlane.observations.length, 0);
  assert.equal(state.feedbackPlane.feedback[0].status, FEEDBACK_STATUS.UNKNOWN);
  assert.equal(feedbackSummary(state).observations, 0);
});
