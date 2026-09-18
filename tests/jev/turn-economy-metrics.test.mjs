import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  emptyJevMetrics,
  parseJevShadowTelemetry,
} from "../../benchmarks/turn-economy/run.mjs";

test("Turn Economy returns explicit zero Jev metrics when shadow telemetry is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "jev-metrics-zero-"));
  try {
    assert.deepEqual(parseJevShadowTelemetry(root), emptyJevMetrics());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Turn Economy aggregates Jev shadow telemetry without claiming realized token savings", () => {
  const root = mkdtempSync(join(tmpdir(), "jev-metrics-"));
  try {
    const dir = resolve(root, ".agents/telemetry");
    mkdirSync(dir, { recursive: true });
    const events = [
      {
        schema: "orchestra.jev-shadow-report.v1",
        shadow_id: "s1",
        jev_calls: 1,
        jev_latency_ms: 20,
        jev_input_tokens: 100,
        jev_candidates: 4,
        jev_ranked_items: 4,
        jev_candidate_bytes: 1000,
        jev_selected_bytes: 400,
        potential_context_reduction: 0.6,
        redundant_tool_candidates: 1,
        rehydration_count: 0,
        fallback_identity_failures: 0,
      },
      {
        schema: "orchestra.jev-shadow-label.v1",
        shadow_id: "s1",
        false_prune_risk: 0,
        future_use_recall_at_k: 1,
        future_use_precision_at_k: 0.75,
        critical_reference_recall: 1,
        false_low_relevance: 0,
        tool_reexecution_delta: 0,
        acceptance_delta: 0,
      },
      {
        schema: "orchestra.jev-shadow-report.v1",
        shadow_id: "s2",
        jev_calls: 1,
        jev_latency_ms: 30,
        jev_input_tokens: 120,
        jev_candidates: 5,
        jev_ranked_items: 5,
        jev_candidate_bytes: 1200,
        jev_selected_bytes: 600,
        potential_context_reduction: 0.5,
        redundant_tool_candidates: 2,
        rehydration_count: 0,
        fallback_identity_failures: 0,
      },
      {
        schema: "orchestra.jev-shadow-label.v1",
        shadow_id: "s2",
        false_prune_risk: 0.1,
        future_use_recall_at_k: 0.8,
        future_use_precision_at_k: 0.8,
        critical_reference_recall: 1,
        false_low_relevance: 0.1,
        tool_reexecution_delta: 0,
        acceptance_delta: 0,
      },
    ];
    writeFileSync(resolve(dir, "jev-shadow.jsonl"), events.map(JSON.stringify).join("\n")+"\n");
    const metrics = parseJevShadowTelemetry(root);
    assert.equal(metrics.jev_calls, 2);
    assert.equal(metrics.jev_latency_ms, 50);
    assert.equal(metrics.jev_candidates, 9);
    assert.equal(metrics.potential_context_reduction, 0.55);
    assert.equal(metrics.future_use_recall_at_k, 0.9);
    assert.equal(metrics.critical_reference_recall, 1);
    assert.equal("input_tokens_saved" in metrics, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
