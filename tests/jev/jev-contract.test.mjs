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
import { rankCandidates } from "../../experiments/jev/artifact-ranker.mjs";
import { buildCounterfactualPacket, assertMandatoryCoreIdentity } from "../../experiments/jev/packet-builder.mjs";
import { buildRetrievalAssistedPacket } from "../../experiments/jev/retrieval-assist.mjs";
import {
  createEvaluationReport,
  createLocalApproval,
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
    report: null,
    mandatoryCore: core,
    candidates: [],
    ranking: { items: [] },
    env: {},
  });
  assert.equal(result.active, false);
  assert.equal(result.fallback_identity, true);
  assert.equal(result.packet, core);
});

test("retrieval assist activates only with eligible report + matching human approval + feature flag", () => {
  const root = mkdtempSync(join(tmpdir(), "jev-gate-"));
  try {
    mkdirSync(join(root, ".agents"), { recursive: true });
    const runs = Array.from({ length: 30 }, (_, i) => ({
      task_category: ["status", "lookup", "simple", "multi", "investigation"][i % 5],
      jev_calls: 1,
      jev_latency_ms: 10,
      jev_input_tokens: 10,
      jev_candidates: 4,
      jev_ranked_items: 4,
      jev_candidate_bytes: 1000,
      jev_selected_bytes: 500,
      potential_context_reduction: 0.5,
      future_use_recall_at_k: 1,
      future_use_precision_at_k: 0.8,
      critical_reference_recall: 1,
      false_low_relevance: 0,
      redundant_tool_candidates: 0,
      rehydration_count: 0,
      tool_reexecution_delta: 0,
      acceptance_delta: 0,
      fallback_identity_failures: 0,
    }));
    const report = createEvaluationReport(runs);
    assert.equal(report.eligible_for_retrieval_assist, true);
    const approval = createLocalApproval({ report });
    writeLocalApproval(root, approval);

    const core = { goal: "x", scopeContract: { allowedPaths: ["src/**"] } };
    const result = buildRetrievalAssistedPacket({
      projectRoot: root,
      report,
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
