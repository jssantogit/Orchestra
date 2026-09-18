import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JEV_AUTHORITY,
  JEV_SCHEMAS,
} from "../../experiments/jev/schemas.mjs";
import { projectForJev, redactSecrets } from "../../experiments/jev/outbound-projector.mjs";
import { JevClient, createFakeJevClient } from "../../experiments/jev/client.mjs";
import { generateCandidates } from "../../experiments/jev/candidate-generator.mjs";
import {
  rankCandidates,
  selectRankedReferences,
} from "../../experiments/jev/artifact-ranker.mjs";
import { buildCounterfactualPacket, assertMandatoryCoreIdentity } from "../../experiments/jev/packet-builder.mjs";
import { buildRetrievalAssistedPacket } from "../../experiments/jev/retrieval-assist.mjs";
import { evaluateLiveEgress } from "../../experiments/jev/egress-policy.mjs";
import {
  createProjectEvaluationReport,
  createLocalApproval,
  checkRetrievalAssistGate,
  writeEvaluationReport,
  writeLocalApproval,
} from "../../experiments/jev/activation-gate.mjs";

function c(id, overrides = {}) {
  return {
    schema: JEV_SCHEMAS.CANDIDATE,
    id,
    authority: JEV_AUTHORITY,
    kind: "ARTIFACT",
    source_kind: "TEST",
    summary: "focused auth test result",
    bytes: 100,
    tags: ["auth", "test"],
    pinned: false,
    freshness: "CURRENT",
    ...overrides,
  };
}

test("outbound projector accepts only bounded metadata and strips absolute paths", () => {
  const projection = projectForJev({
    goal: "fix auth parser",
    task: { task_id: "t1" },
    candidates: [
      c("c1", { relative_path: "src/auth.js", summary: "token=sk-12345678901234567890" }),
      c("c2", { relative_path: "/root/private.txt" }),
    ],
  });
  assert.equal(projection.authority, "NONE");
  assert.equal(projection.candidates[0].summary.includes("sk-12345678901234567890"), false);
  assert.equal(projection.candidates[0].relative_path, "src/auth.js");
  assert.equal("relative_path" in projection.candidates[1], false);
});

test("outbound projector rejects raw content fields structurally", () => {
  assert.throws(
    () => projectForJev({
      goal: "x",
      candidates: [c("raw", { rawContent: "secret body" })],
    }),
    /JEV_EGRESS_FORBIDDEN_FIELD/,
  );
});

test("secret redaction covers common credential forms", () => {
  const out = redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz token=supersecretvalue");
  assert.equal(out.includes("abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(out.includes("supersecretvalue"), false);
});

test("live project egress is denied by default and requires explicit opt-in", () => {
  const denied = evaluateLiveEgress({
    projectRoot: "/tmp/private-project",
    live: true,
    env: {},
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "JEV_PROJECT_EGRESS_REQUIRES_EXPLICIT_OPT_IN");

  const allowed = evaluateLiveEgress({
    projectRoot: "/tmp/private-project",
    live: true,
    env: { ORCHESTRA_JEV_ALLOW_PROJECT_EGRESS: "1" },
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.mode, "EXPLICIT_PROJECT_EGRESS");
});

test("candidate generation is deterministic, bounded and preserves pins", () => {
  const catalog = {
    candidates: [
      c("a", { summary: "formatter output", pinned: true }),
      c("b", { summary: "auth parser failure" }),
      c("c", { summary: "unrelated docs" }),
    ],
  };
  const one = generateCandidates({ catalog, goal: "auth parser", maxCandidates: 2 });
  const two = generateCandidates({ catalog, goal: "auth parser", maxCandidates: 2 });
  assert.deepEqual(one.selected.map((x) => x.id), two.selected.map((x) => x.id));
  assert.equal(one.selected[0].id, "a");
  assert.equal(one.selected.length, 2);
});

test("client accepts projection only and validates live response", async () => {
  const projection = projectForJev({ goal: "x", candidates: [c("a")] });
  let body = null;
  const client = new JevClient({
    apiKey: "test",
    baseUrl: "https://example.test/jev",
    allowTestEndpoint: true,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        status: 200,
        ok: true,
        async text() {
          return JSON.stringify({ model: "jev-test", answers: { q: { noul: 0.7 } } });
        },
      };
    },
  });
  const response = await client.ask(projection, { q: { type: "noul", instructions: "x" } }, { live: true });
  assert.equal(response.answers.q.noul, 0.7);
  assert.equal(body.state.schema, JEV_SCHEMAS.PROJECTION);
  await assert.rejects(
    () => client.ask({ activeState: { secret: true } }, {}, { live: true }),
    /JEV_INVALID_PROJECTION/,
  );
});

test("semantic ranking batches 64 candidates and preserves all pinned references beyond soft budgets", async () => {
  const candidates = Array.from({ length: 64 }, (_, i) => c(`batch-${i}`, {
    pinned: i < 10,
    bytes: 100,
    summary: `candidate ${i}`,
  }));
  const projection = projectForJev({ goal: "large candidate set", candidates });
  let calls = 0;
  const client = {
    async ask(_projection, questions) {
      calls++;
      const answers = {};
      for (const name of Object.keys(questions)) answers[name] = { noul: 0.5 };
      return {
        model: "jev-fake",
        answers,
        usage: { input_tokens: 1, output_tokens: 1 },
        latency_ms: 1,
      };
    },
  };
  const ranking = await rankCandidates({ client, projection, live: true });
  assert.equal(ranking.request_count, 2);
  assert.equal(calls, 2);
  assert.equal(ranking.items.length, 64);

  const selected = selectRankedReferences({
    candidates,
    ranking,
    maxItems: 3,
    maxBytes: 250,
  });
  assert.equal(selected.selected.length, 10);
  assert.deepEqual(
    selected.selected.map((item) => item.id),
    candidates.slice(0, 10).map((item) => item.id),
  );
});

test("Jev ranking cannot alter mandatory packet core", async () => {
  const candidates = [c("a", { bytes: 10 }), c("b", { bytes: 20 })];
  const projection = projectForJev({ goal: "auth", candidates });
  const client = createFakeJevClient(({ name }) => name.includes("a") ? 0.9 : 0.2);
  const ranking = await rankCandidates({ client, projection, live: true });
  const mandatoryCore = {
    goal: "auth",
    scopeContract: { allowedPaths: ["src/**"], forbiddenPaths: [".agents/**"] },
    requiredEvidence: ["TEST_RUN"],
    retries: { remaining: 1 },
  };
  const packet = buildCounterfactualPacket({ mandatoryCore, candidates, ranking });
  assert.equal(assertMandatoryCoreIdentity(mandatoryCore, packet), true);
  assert.equal(packet.authority, "NONE");
});

test("retrieval assist is identity fallback without flag/report/approval", () => {
  const core = { goal: "x", scopeContract: { allowedPaths: ["src/**"] } };
  const result = buildRetrievalAssistedPacket({
    projectRoot: "/tmp/no-approval",
    mandatoryCore: core,
    candidates: [],
    ranking: { items: [] },
    env: {},
  });
  assert.equal(result.active, false);
  assert.equal(result.fallback_identity, true);
  assert.equal(result.packet, core);
});

test("unlabeled shadow reports can never become Retrieval Assist evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "jev-unlabeled-"));
  try {
    const telemetryDir = join(root, ".agents", "telemetry");
    mkdirSync(telemetryDir, { recursive: true });
    const reports = Array.from({ length: 40 }, (_, i) => ({
      schema: "orchestra.jev-shadow-report.v1",
      shadow_id: `unlabeled-${i}`,
      task_category: ["status", "lookup", "simple", "multi", "investigation"][i % 5],
      jev_calls: 1,
      potential_context_reduction: 0.9,
    }));
    writeFileSync(join(telemetryDir, "jev-shadow.jsonl"), reports.map(JSON.stringify).join("\n")+"\n");
    const report = createProjectEvaluationReport(root);
    assert.equal(report.source_labeled_run_count, 0);
    assert.equal(report.eligible_for_retrieval_assist, false);
    assert.ok(report.violations.includes("INSUFFICIENT_SAMPLES"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed or post-approval shadow telemetry invalidates Retrieval Assist", () => {
  const root = mkdtempSync(join(tmpdir(), "jev-tamper-"));
  try {
    const telemetryDir = join(root, ".agents", "telemetry");
    mkdirSync(telemetryDir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 30; i++) {
      const shadowId = `s-${i}`;
      lines.push(JSON.stringify({
        schema: "orchestra.jev-shadow-report.v1",
        authority: "NONE",
        shadow_id: shadowId,
        task_category: ["status", "lookup", "simple", "multi", "investigation"][i % 5],
        jev_calls: 1,
        jev_candidate_bytes: 1000,
        jev_selected_bytes: 400,
        potential_context_reduction: 0.6,
        fallback_identity_failures: 0,
      }));
      lines.push(JSON.stringify({
        schema: "orchestra.jev-shadow-label.v1",
        authority: "NONE",
        label_source: "PROJECT_RUNTIME_TELEMETRY",
        shadow_id: shadowId,
        future_use_recall_at_k: 1,
        future_use_precision_at_k: 0.8,
        critical_reference_recall: 1,
        false_low_relevance: 0,
        false_prune_risk: 0,
        comparative_outcome_verified: true,
        comparison_source: "CONTROLLED_A_B_FIXTURE",
        tool_reexecution_delta: 0,
        acceptance_delta: 0,
      }));
    }
    const telemetryPath = join(telemetryDir, "jev-shadow.jsonl");
    writeFileSync(telemetryPath, lines.join("\n")+"\n");
    const report = createProjectEvaluationReport(root);
    assert.equal(report.eligible_for_retrieval_assist, true);
    writeEvaluationReport(root, report);
    writeLocalApproval(root, createLocalApproval({ report }));

    let gate = checkRetrievalAssistGate({
      projectRoot: root,
      env: { ORCHESTRA_JEV_RETRIEVAL_ASSIST: "1" },
    });
    assert.equal(gate.allowed, true);

    writeFileSync(telemetryPath, JSON.stringify({ schema: "orchestra.jev-shadow-report.v1", shadow_id: "new" })+"\n", { flag: "a" });
    gate = checkRetrievalAssistGate({
      projectRoot: root,
      env: { ORCHESTRA_JEV_RETRIEVAL_ASSIST: "1" },
    });
    assert.equal(gate.allowed, false);
    assert.ok(gate.reasons.includes("SHADOW_TELEMETRY_CHANGED"));

    writeFileSync(telemetryPath, "{malformed-json}\n", { flag: "a" });
    const malformedReport = createProjectEvaluationReport(root);
    assert.equal(malformedReport.eligible_for_retrieval_assist, false);
    assert.ok(malformedReport.violations.includes("MALFORMED_SHADOW_TELEMETRY"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retrieval assist activates only with eligible report + matching human approval + feature flag", () => {
  const root = mkdtempSync(join(tmpdir(), "jev-gate-"));
  try {
    mkdirSync(join(root, ".agents"), { recursive: true });
    const telemetryDir = join(root, ".agents", "telemetry");
    mkdirSync(telemetryDir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 30; i++) {
      const shadowId = `shadow-${i}`;
      lines.push({
        schema: "orchestra.jev-shadow-report.v1",
        authority: "NONE",
        shadow_id: shadowId,
        task_category: ["status", "lookup", "simple", "multi", "investigation"][i % 5],
        jev_calls: 1,
        jev_latency_ms: 10,
        jev_input_tokens: 10,
        jev_candidates: 4,
        jev_ranked_items: 4,
        jev_candidate_bytes: 1000,
        jev_selected_bytes: 500,
        potential_context_reduction: 0.5,
        redundant_tool_candidates: 0,
        rehydration_count: 0,
        tool_reexecution_delta: 0,
        acceptance_delta: 0,
        fallback_identity_failures: 0,
      });
      lines.push({
        schema: "orchestra.jev-shadow-label.v1",
        authority: "NONE",
        label_source: "PROJECT_RUNTIME_TELEMETRY",
        shadow_id: shadowId,
        future_event_count: 2,
        future_used_total: 2,
        critical_reference_total: 1,
        future_use_recall_at_k: 1,
        future_use_precision_at_k: 0.8,
        critical_reference_recall: 1,
        false_low_relevance: 0,
        false_prune_risk: 0,
        comparative_outcome_verified: true,
        comparison_source: "CONTROLLED_A_B_FIXTURE",
        tool_reexecution_delta: 0,
        acceptance_delta: 0,
      });
    }
    writeFileSync(join(telemetryDir, "jev-shadow.jsonl"), lines.map(JSON.stringify).join("\n")+"\n");
    const report = createProjectEvaluationReport(root);
    assert.equal(report.eligible_for_retrieval_assist, true);
    writeEvaluationReport(root, report);
    const approval = createLocalApproval({ report });
    writeLocalApproval(root, approval);

    const core = { goal: "x", scopeContract: { allowedPaths: ["src/**"] } };
    const result = buildRetrievalAssistedPacket({
      projectRoot: root,
      mandatoryCore: core,
      candidates: [],
      ranking: { items: [] },
      env: { ORCHESTRA_JEV_RETRIEVAL_ASSIST: "1" },
    });
    assert.equal(result.active, true);
    assert.equal(result.packet.mandatory_core, core);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
