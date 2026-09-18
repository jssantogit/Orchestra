#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JevClient, createFakeJevClient } from "../../experiments/jev/client.mjs";
import { projectForJev } from "../../experiments/jev/outbound-projector.mjs";
import { rankCandidates, selectRankedReferences } from "../../experiments/jev/artifact-ranker.mjs";
import { evaluateRankingAgainstFutureUse } from "../../experiments/jev/future-use-oracle.mjs";
import { aggregateJevRuns } from "../../experiments/jev/evaluator.mjs";
import { JEV_AUTHORITY, JEV_SCHEMAS } from "../../experiments/jev/schemas.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultOutput = resolve(__dirname, "results/jev-shadow-summary.json");

function candidate(id, kind, summary, { pinned = false, bytes = 100, tags = [] } = {}) {
  return {
    schema: JEV_SCHEMAS.CANDIDATE,
    id,
    authority: JEV_AUTHORITY,
    kind,
    source_kind: "TURN_ECONOMY_SYNTHETIC",
    summary,
    bytes,
    tags,
    pinned,
    freshness: "CURRENT",
  };
}

export const JEV_TURN_ECONOMY_CASES = Object.freeze([
  {
    task_category: "status",
    goal: "Show current git status concisely without modifying anything.",
    candidates: [
      candidate("status-git", "ARTIFACT", "Current git status porcelain output", { pinned: true, tags: ["git", "status"] }),
      candidate("status-tests", "EVIDENCE", "Previous formatter unit test result", { tags: ["test", "formatter"] }),
      candidate("status-readme", "ARTIFACT", "README architecture notes", { tags: ["docs"] }),
    ],
    futureEvents: [{ type: "FINAL_RESPONSE", reference: "status-git" }],
    criticalIds: ["status-git"],
  },
  {
    task_category: "lookup",
    goal: "Find where numeric input validation is implemented and identify rejected values.",
    candidates: [
      candidate("lookup-parser", "ARTIFACT", "Search result points to src/parser.js validateNumericInput", { pinned: true, tags: ["parser", "validation"] }),
      candidate("lookup-formatter", "ARTIFACT", "Formatter implementation", { tags: ["formatter"] }),
      candidate("lookup-tests", "EVIDENCE", "Parser tests covering invalid numeric inputs", { tags: ["parser", "test"] }),
      candidate("lookup-git", "ARTIFACT", "Git status output", { tags: ["git"] }),
    ],
    futureEvents: [
      { type: "READ", candidateId: "lookup-parser" },
      { type: "FINAL_RESPONSE", candidateId: "lookup-tests" },
    ],
    criticalIds: ["lookup-parser"],
  },
  {
    task_category: "simple",
    goal: "Fix negative number formatting and validate the focused test.",
    candidates: [
      candidate("simple-formatter", "ARTIFACT", "src/formatter.js implementation of formatNumber", { pinned: true, tags: ["formatter"] }),
      candidate("simple-focused-test", "EVIDENCE", "Focused formatter test output for negative numbers", { tags: ["formatter", "test"] }),
      candidate("simple-parser", "ARTIFACT", "Parser implementation unrelated to formatting sign", { tags: ["parser"] }),
      candidate("simple-old-build", "EVIDENCE", "Historical full build passed before current mutation", { tags: ["build", "stale"] }),
    ],
    futureEvents: [
      { type: "MUTATION", candidateId: "simple-formatter" },
      { type: "ACCEPTANCE", candidateId: "simple-focused-test" },
    ],
    criticalIds: ["simple-formatter", "simple-focused-test"],
  },
  {
    task_category: "multi",
    goal: "Add optional precision formatting while preserving default behavior and parser/formatter boundary.",
    candidates: [
      candidate("multi-formatter", "ARTIFACT", "Formatter options and precision implementation", { pinned: true, tags: ["formatter", "precision"] }),
      candidate("multi-calculator", "ARTIFACT", "Calculator forwards formatting options", { tags: ["calculator", "options"] }),
      candidate("multi-parser", "ARTIFACT", "Parser boundary behavior", { tags: ["parser", "boundary"] }),
      candidate("multi-tests", "EVIDENCE", "Formatter and calculator focused tests", { tags: ["test", "precision"] }),
      candidate("multi-status", "ARTIFACT", "Git status output", { tags: ["git"] }),
    ],
    futureEvents: [
      { type: "MUTATION", candidateId: "multi-formatter" },
      { type: "READ", candidateId: "multi-calculator" },
      { type: "ACCEPTANCE", candidateId: "multi-tests" },
    ],
    criticalIds: ["multi-formatter", "multi-tests"],
  },
  {
    task_category: "investigation",
    goal: "Investigate intermittent decimal percentage failure, find root cause, fix and validate.",
    candidates: [
      candidate("investigation-parser", "ARTIFACT", "Parser percentage grammar implementation", { pinned: true, tags: ["parser", "percentage"] }),
      candidate("investigation-failing-test", "EVIDENCE", "Focused decimal percentage test failed", { pinned: true, tags: ["test", "failure"] }),
      candidate("investigation-hypothesis", "FEEDBACK", "Hypothesis: integer-only grammar rejects decimal percentage", { tags: ["hypothesis", "parser"] }),
      candidate("investigation-old-format", "ARTIFACT", "Historical formatter output unrelated to parser failure", { tags: ["formatter"] }),
      candidate("investigation-revalidation", "EVIDENCE", "Repeated passing validation without intervening mutation", { tags: ["redundant", "validation"] }),
    ],
    futureEvents: [
      { type: "FEEDBACK", candidateId: "investigation-hypothesis" },
      { type: "MUTATION", candidateId: "investigation-parser" },
      { type: "ACCEPTANCE", candidateId: "investigation-failing-test" },
    ],
    criticalIds: ["investigation-parser", "investigation-failing-test"],
  },
  {
    task_category: "critical",
    goal: "Conduct independent Two-Key critical review of security boundaries.",
    candidates: [
      candidate("critical-scope", "ARTIFACT", "Scope Contract and authority boundary specification", { pinned: true, tags: ["security", "scope"] }),
      candidate("critical-trust", "ARTIFACT", "Context and side-effect trust-boundary implementation", { pinned: true, tags: ["security", "trust"] }),
      candidate("critical-firewall", "EVIDENCE", "Cross-runtime firewall test results", { tags: ["security", "firewall", "test"] }),
      candidate("critical-ui", "ARTIFACT", "Unrelated UI fixture notes", { tags: ["ui"] }),
    ],
    futureEvents: [
      { type: "REVIEW", candidateId: "critical-scope" },
      { type: "REVIEW", candidateId: "critical-trust" },
      { type: "ACCEPTANCE", candidateId: "critical-firewall" },
    ],
    criticalIds: ["critical-scope", "critical-trust", "critical-firewall"],
  },
]);

function materializeFutureEvents(caseDef) {
  return caseDef.futureEvents.map((event) => ({
    ...event,
    id: event.candidateId || event.reference || null,
  }));
}

export async function runJevTurnEconomyEvaluation({
  client,
  live = false,
} = {}) {
  const runs = [];
  for (const caseDef of JEV_TURN_ECONOMY_CASES) {
    const projection = projectForJev({
      goal: caseDef.goal,
      task: {
        task_id: `turn-economy-${caseDef.task_category}`,
        task_action: caseDef.task_category.toUpperCase(),
        task_domain: "CODE",
        criticality: caseDef.task_category === "critical" ? "CRITICAL" : "NORMAL",
      },
      candidates: caseDef.candidates,
      includeRelativePaths: false,
    });
    const ranking = await rankCandidates({ client, projection, live });
    const selection = selectRankedReferences({
      candidates: caseDef.candidates,
      ranking,
      maxItems: 3,
      maxBytes: 100000,
    });

    // The oracle searches factual identifiers in event JSON. Add explicit IDs.
    const futureEvents = materializeFutureEvents(caseDef).map((event) => ({
      ...event,
      candidate_ref: event.id,
    }));
    const oracleEvents = futureEvents.map((event) => {
      const candidate = caseDef.candidates.find((item) => item.id === event.id);
      return {
        ...event,
        evidence_id: candidate?.id,
        path: candidate?.id,
      };
    });
    const oracle = evaluateRankingAgainstFutureUse({
      candidates: caseDef.candidates.map((item) => ({
        ...item,
        evidence_id: item.id,
      })),
      ranking,
      selectedIds: selection.selected_ids,
      futureEvents: oracleEvents,
      criticalIds: caseDef.criticalIds,
    });
    const candidateBytes = selection.candidate_bytes || 0;
    runs.push({
      task_category: caseDef.task_category,
      jev_calls: ranking.skipped ? 0 : (ranking.request_count || 1),
      jev_latency_ms: ranking.latency_ms || 0,
      jev_input_tokens: ranking.usage?.input_tokens || 0,
      jev_candidates: caseDef.candidates.length,
      jev_ranked_items: ranking.items?.length || 0,
      jev_candidate_bytes: candidateBytes,
      jev_selected_bytes: selection.selected_bytes || 0,
      potential_context_reduction: candidateBytes > 0
        ? Number((1 - selection.selected_bytes / candidateBytes).toFixed(6))
        : 0,
      redundant_tool_candidates: 0,
      rehydration_count: 0,
      future_use_recall_at_k: oracle.future_use_recall_at_k,
      future_use_precision_at_k: oracle.future_use_precision_at_k,
      critical_reference_recall: oracle.critical_reference_recall,
      false_low_relevance: oracle.false_low_relevance,
      comparative_outcome_verified: false,
      comparison_source: null,
      tool_reexecution_delta: null,
      acceptance_delta: null,
      fallback_identity_failures: 0,
      selected_ids: selection.selected_ids,
    });
  }

  return {
    schema: "orchestra.jev-turn-economy.v1",
    mode: live ? "LIVE_SHADOW" : "OFFLINE_FAKE",
    authority: "NONE",
    generated_at: new Date().toISOString(),
    cases: runs,
    aggregate: aggregateJevRuns(runs),
  };
}

async function main() {
  const live = process.argv.includes("--live");
  const client = live
    ? new JevClient()
    : createFakeJevClient(({ projection, name }) => {
        const candidateId = name.split("__")[1] || "";
        const candidate = projection.candidates.find((item) => item.id === candidateId);
        if (!candidate) return 0.5;
        const tags = new Set(candidate.tags || []);
        if (name.startsWith("duplicate__")) return tags.has("redundant") || tags.has("stale") ? 0.9 : 0.15;
        if (candidate.pinned) return 0.98;
        if (tags.has("test") || tags.has("security") || tags.has("parser") || tags.has("formatter")) return 0.8;
        return 0.25;
      });
  const report = await runJevTurnEconomyEvaluation({ client, live });
  const output = process.env.JEV_TURN_ECONOMY_OUTPUT
    ? resolve(process.env.JEV_TURN_ECONOMY_OUTPUT)
    : defaultOutput;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ output, aggregate: report.aggregate }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
