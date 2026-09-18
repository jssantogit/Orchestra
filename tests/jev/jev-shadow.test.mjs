import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createFakeJevClient } from "../../experiments/jev/client.mjs";
import { buildCatalog } from "../../experiments/jev/catalog-builder.mjs";
import { runArtifactRankingShadow, readShadowTelemetry } from "../../experiments/jev/shadow-runner.mjs";
import { scoreRedundancyShadow } from "../../experiments/jev/redundancy-shadow.mjs";
import { annotateDreamDirectory } from "../../experiments/jev/dream-analyzer.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jev-shadow-"));
  mkdirSync(resolve(root, ".agents/state"), { recursive: true });
  mkdirSync(resolve(root, ".agents/artifacts/outputs"), { recursive: true });
  writeFileSync(resolve(root, ".agents/artifacts/outputs/test.log"), "full raw test output\n".repeat(20));
  writeFileSync(resolve(root, ".agents/state/active-state.json"), JSON.stringify({
    taskId: "task-shadow",
    mutationSeq: 3,
    evidenceLedger: [{
      id: "ev-1",
      executionId: "exec-1",
      type: "TEST_RUN",
      command: "node --test test/auth.test.js",
      exitCode: 1,
      artifactPath: ".agents/artifacts/outputs/test.log",
      mutationSeq: 2,
      fresh: true,
      required: true,
    }],
    mutations: [{ mutationSeq: 3, type: "EDIT", paths: ["src/auth.js"] }],
    feedbackPlane: { feedback: [{ hypothesis_id: "h1", status: "FALSIFIED" }] },
  }, null, 2));
  return root;
}

test("catalog references factual memory without embedding raw artifact body", () => {
  const root = fixture();
  try {
    const catalog = buildCatalog(root);
    assert.ok(catalog.candidates.length >= 3);
    const serialized = JSON.stringify(catalog);
    assert.equal(serialized.includes("full raw test output"), false);
    assert.ok(catalog.candidates.some((c) => c.evidence_id === "ev-1"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact ranking shadow writes telemetry and never changes packet behavior", async () => {
  const root = fixture();
  try {
    const client = createFakeJevClient(({ name }) => {
      if (name.startsWith("useful__")) return 0.8;
      if (name.startsWith("future__")) return 0.7;
      if (name.startsWith("duplicate__")) return 0.2;
      return 0.5;
    });
    const result = await runArtifactRankingShadow({
      projectRoot: root,
      client,
      goal: "fix auth test",
      task: { task_id: "task-shadow", task_category: "investigation" },
      live: true,
      env: { ORCHESTRA_JEV_ALLOW_PROJECT_EGRESS: "1" },
      mandatoryCore: { goal: "fix auth test", requiredEvidence: ["TEST_RUN"] },
      futureEvents: [{ type: "ACCEPTANCE", evidenceId: "ev-1" }],
      criticalIds: [],
    });
    assert.equal(result.event.blocks_tool, false);
    assert.equal(result.event.changes_packet, false);
    assert.equal(result.counterfactualPacket.mode, "COUNTERFACTUAL");
    assert.equal(readShadowTelemetry(root).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("redundancy shadow is telemetry-only and cannot deny the tool", async () => {
  const client = createFakeJevClient(({ name }) => name === "likely_redundant" ? 0.92 : 0.08);
  const result = await scoreRedundancyShadow({
    client,
    goal: "find parser",
    proposedToolCall: { tool: "grep_search", args: { query: "parser" } },
    recentToolCalls: [{ tool: "grep_search", args: { query: "parser" }, result: "src/parser.js:10" }],
    live: true,
  });
  assert.equal(result.blocks_tool, false);
  assert.equal(result.p_redundant, 0.92);
  assert.equal(result.p_adds_new_information, 0.08);
});

test("Dream analysis writes sidecars only and leaves world bytes unchanged", async () => {
  const root = fixture();
  try {
    const worlds = resolve(root, ".agents/dream-data/worlds");
    mkdirSync(worlds, { recursive: true });
    const worldPath = resolve(worlds, "w1.json");
    const world = {
      world_id: "w1",
      decisions: [{ decision_id: "d1", decision_type: "WORKER_TIER", chosen_action: "FLASH_LOW" }],
      outcomes: [{ observation_id: "o1", decision_id: "d1", terminal_state: "ACCEPTED" }],
    };
    writeFileSync(worldPath, JSON.stringify(world, null, 2));
    const before = readFileSync(worldPath, "utf8");
    const client = createFakeJevClient(() => 0.5);
    const out = await annotateDreamDirectory({
      projectRoot: root,
      client,
      live: true,
      env: { ORCHESTRA_JEV_ALLOW_PROJECT_EGRESS: "1" },
    });
    assert.equal(out.annotated, 1);
    assert.equal(readFileSync(worldPath, "utf8"), before);
    const sidecar = JSON.parse(readFileSync(out.paths[0], "utf8"));
    assert.equal(sidecar.authority, "NONE");
    assert.equal(sidecar.world_id, "w1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
