import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  JEV_AUTHORITY,
  JEV_SCHEMAS,
  contentId,
} from "./schemas.mjs";
import { projectForJev } from "./outbound-projector.mjs";
import { rankCandidates } from "./artifact-ranker.mjs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function worldCandidates(world) {
  const candidates = [];
  for (const decision of world.decisions || []) {
    candidates.push({
      schema: JEV_SCHEMAS.CANDIDATE,
      id: contentId("jev-world-decision", { world_id: world.world_id, decision_id: decision.decision_id }),
      authority: JEV_AUTHORITY,
      kind: "DREAM_DECISION",
      source_kind: decision.decision_type || "DECISION",
      summary: `${decision.decision_type || "decision"} chose ${decision.chosen_action || "unknown"}`,
      bytes: 0,
      tags: ["dream", "decision", decision.decision_type || "unknown"],
      pinned: false,
      freshness: "HISTORICAL",
    });
  }
  for (const outcome of world.outcomes || []) {
    candidates.push({
      schema: JEV_SCHEMAS.CANDIDATE,
      id: contentId("jev-world-outcome", { world_id: world.world_id, observation_id: outcome.observation_id }),
      authority: JEV_AUTHORITY,
      kind: "DREAM_OUTCOME",
      source_kind: outcome.terminal_state || "OUTCOME",
      summary: `Outcome ${outcome.terminal_state || "UNKNOWN"} for decision ${outcome.decision_id || "unknown"}`,
      bytes: 0,
      tags: ["dream", "outcome", outcome.terminal_state || "unknown"],
      pinned: false,
      freshness: "HISTORICAL",
    });
  }
  return candidates;
}

export async function annotateDreamWorld({
  world,
  client,
  goal = "Identify historical observations most predictive of useful next actions.",
  live = false,
} = {}) {
  const projection = projectForJev({
    goal,
    task: { task_id: world.world_id, task_action: "DREAM_ANALYSIS", task_domain: "POLICY", criticality: "NORMAL" },
    candidates: worldCandidates(world),
    includeRelativePaths: false,
  });
  const ranking = await rankCandidates({ client, projection, live });
  return {
    schema: JEV_SCHEMAS.DREAM_ANNOTATION,
    annotation_id: contentId("jev-dream-annotation", {
      world_id: world.world_id,
      ranking_id: ranking.ranking_id,
    }),
    authority: JEV_AUTHORITY,
    world_id: world.world_id,
    world_hash: contentId("world-content", world),
    created_at: new Date().toISOString(),
    ranking,
  };
}

export async function annotateDreamDirectory({
  projectRoot,
  client,
  live = false,
} = {}) {
  const worldsDir = resolve(projectRoot, ".agents/dream-data/worlds");
  const outputDir = resolve(projectRoot, ".agents/dream-data/jev-annotations");
  if (!existsSync(worldsDir)) return { annotated: 0, paths: [] };
  mkdirSync(outputDir, { recursive: true });

  const paths = [];
  for (const name of readdirSync(worldsDir).filter((item) => item.endsWith(".json")).sort()) {
    const worldPath = resolve(worldsDir, name);
    const world = readJson(worldPath);
    const before = JSON.stringify(world);
    const annotation = await annotateDreamWorld({ world, client, live });
    if (JSON.stringify(readJson(worldPath)) !== before) throw new Error("JEV_DREAM_WORLD_MUTATED");
    const outPath = resolve(outputDir, `${world.world_id || name.replace(/\.json$/, "")}.jev.json`);
    writeFileSync(outPath, JSON.stringify(annotation, null, 2), "utf8");
    paths.push(outPath);
  }
  return { annotated: paths.length, paths };
}
