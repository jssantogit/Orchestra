import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import {
  JEV_AUTHORITY,
  JEV_SCHEMAS,
  contentId,
} from "./schemas.mjs";

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function rel(root, path) {
  return relative(root, path).replace(/\\/g, "/");
}

function candidate(fields) {
  const base = {
    schema: JEV_SCHEMAS.CANDIDATE,
    authority: JEV_AUTHORITY,
    pinned: false,
    tags: [],
    ...fields,
  };
  base.id ||= contentId("jev-candidate", {
    kind: base.kind,
    source_kind: base.source_kind,
    relative_path: base.relative_path,
    evidence_id: base.evidence_id,
    execution_id: base.execution_id,
    mutation_seq: base.mutation_seq,
    summary: base.summary,
  });
  return base;
}

function artifactCandidates(projectRoot, activeState) {
  const out = [];
  const seen = new Set();

  for (const ev of activeState?.evidenceLedger || []) {
    const artifactPath = ev.artifactPath || ev.artifact_path || null;
    const relativePath = artifactPath
      ? String(artifactPath).replace(/\\/g, "/").replace(/^\.\//, "")
      : null;
    let bytes = 0;
    if (relativePath) {
      const absolute = resolve(projectRoot, relativePath);
      try { bytes = statSync(absolute).size; } catch {}
    }
    out.push(candidate({
      kind: "EVIDENCE",
      source_kind: ev.type || "EVIDENCE_LEDGER",
      relative_path: relativePath,
      evidence_id: ev.id || ev.evidenceId || ev.executionId || null,
      execution_id: ev.executionId || null,
      task_id: activeState.taskId || null,
      mutation_seq: Number.isInteger(ev.mutationSeq) ? ev.mutationSeq : null,
      result: ev.exitCode === 0 ? "PASS" : (Number.isInteger(ev.exitCode) ? "FAIL" : "UNKNOWN"),
      summary: [
        ev.type || "evidence",
        ev.command ? `command=${String(ev.command).slice(0, 180)}` : "",
        Number.isInteger(ev.exitCode) ? `exit=${ev.exitCode}` : "",
      ].filter(Boolean).join(" | "),
      bytes,
      tags: ["evidence", ev.type || "unknown"].filter(Boolean),
      pinned: ev.required === true,
      freshness: ev.fresh === false ? "STALE" : "CURRENT",
    }));
    if (relativePath) seen.add(relativePath);
  }

  const artifactsDir = resolve(projectRoot, ".agents/artifacts/outputs");
  if (existsSync(artifactsDir)) {
    for (const name of readdirSync(artifactsDir).sort()) {
      const absolute = resolve(artifactsDir, name);
      let stat;
      try { stat = statSync(absolute); } catch { continue; }
      if (!stat.isFile()) continue;
      const relativePath = rel(projectRoot, absolute);
      if (seen.has(relativePath)) continue;
      out.push(candidate({
        kind: "ARTIFACT",
        source_kind: "OUTPUT_ARTIFACT",
        relative_path: relativePath,
        task_id: activeState?.taskId || null,
        mutation_seq: Number.isInteger(activeState?.mutationSeq) ? activeState.mutationSeq : null,
        result: "UNKNOWN",
        summary: `Persisted output artifact ${name}`,
        bytes: stat.size,
        tags: ["artifact", "output"],
        freshness: "HISTORICAL",
      }));
    }
  }
  return out;
}

function stateCandidates(activeState) {
  const out = [];
  for (const mutation of activeState?.mutations || []) {
    out.push(candidate({
      kind: "MUTATION",
      source_kind: "MUTATION_HISTORY",
      task_id: activeState.taskId || null,
      mutation_seq: mutation.mutationSeq ?? mutation.seq ?? null,
      result: "OBSERVED",
      summary: `Mutation ${mutation.type || "EDIT"} on ${(mutation.paths || []).join(", ")}`,
      bytes: 0,
      tags: ["mutation", mutation.type || "edit"],
      relative_path: Array.isArray(mutation.paths) && mutation.paths.length === 1 ? mutation.paths[0] : null,
      freshness: "CURRENT",
    }));
  }

  for (const feedback of activeState?.feedbackPlane?.feedback || []) {
    out.push(candidate({
      kind: "FEEDBACK",
      source_kind: "ATTRIBUTABLE_FEEDBACK",
      task_id: activeState.taskId || null,
      result: feedback.status || "UNKNOWN",
      summary: `Feedback ${feedback.status || "UNKNOWN"} for hypothesis ${feedback.hypothesis_id || "unknown"}`,
      bytes: 0,
      tags: ["feedback", feedback.status || "unknown"],
      freshness: "CURRENT",
    }));
  }
  return out;
}

function worldCandidates(projectRoot) {
  const dir = resolve(projectRoot, ".agents/dream-data/worlds");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).filter((item) => item.endsWith(".json")).sort()) {
    const absolute = resolve(dir, name);
    const world = readJson(absolute, null);
    if (!world) continue;
    let bytes = 0;
    try { bytes = statSync(absolute).size; } catch {}
    out.push(candidate({
      kind: "DREAM_WORLD",
      source_kind: "SEALED_WORLD",
      relative_path: rel(projectRoot, absolute),
      result: world.status || "SEALED",
      summary: `Sealed Dream world ${world.world_id || name}; decisions=${world.decisions?.length || 0}; outcomes=${world.outcomes?.length || 0}`,
      bytes,
      tags: ["dream", "world", world.status || "sealed"],
      freshness: "HISTORICAL",
    }));
  }
  return out;
}

export function buildCatalog(projectRoot, { includeDreamWorlds = true } = {}) {
  const root = resolve(projectRoot);
  const activeState = readJson(resolve(root, ".agents/state/active-state.json"), {});
  const candidates = [
    ...artifactCandidates(root, activeState),
    ...stateCandidates(activeState),
    ...(includeDreamWorlds ? worldCandidates(root) : []),
  ];

  const unique = new Map();
  for (const item of candidates) unique.set(item.id, item);
  const values = [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    schema: JEV_SCHEMAS.CATALOG,
    authority: JEV_AUTHORITY,
    generated_at: new Date().toISOString(),
    task_id: activeState.taskId || null,
    mutation_seq: Number.isInteger(activeState.mutationSeq) ? activeState.mutationSeq : null,
    candidate_count: values.length,
    candidates: values,
  };
}
