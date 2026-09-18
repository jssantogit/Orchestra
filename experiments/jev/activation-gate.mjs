import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import {
  JEV_SCHEMAS,
  contentId,
  sha256,
} from "./schemas.mjs";
import { DEFAULT_PROMOTION_GATES, evaluateForRetrievalAssist } from "./evaluator.mjs";

export const APPROVAL_PATH = ".agents/semantic/jev-approval.json";
export const EVALUATION_PATH = ".agents/semantic/jev-evaluation.json";
export const SHADOW_TELEMETRY_PATH = ".agents/telemetry/jev-shadow.jsonl";

export function reportHash(report) {
  return sha256(report);
}

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function shadowTelemetry(projectRoot) {
  const path = resolve(projectRoot, SHADOW_TELEMETRY_PATH);
  let raw = "";
  try { raw = readFileSync(path, "utf8"); } catch {}
  const events = raw.split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed?.schema === JEV_SCHEMAS.SHADOW_REPORT ? [parsed] : [];
    } catch {
      return [];
    }
  });
  return {
    path,
    raw,
    events,
    sha256: sha256(raw),
  };
}

export function createEvaluationReport(runs, gates = DEFAULT_PROMOTION_GATES, provenance = {}) {
  const base = evaluateForRetrievalAssist(runs, gates);
  const report = {
    ...base,
    generated_at: new Date().toISOString(),
    source_kind: provenance.source_kind || "EXPLICIT_RUNS",
    source_telemetry_sha256: provenance.source_telemetry_sha256 || null,
    source_event_count: Number.isInteger(provenance.source_event_count)
      ? provenance.source_event_count
      : runs.length,
  };
  delete report.report_id;
  report.report_id = contentId("jev-evaluation", report);
  return report;
}

export function createProjectEvaluationReport(projectRoot, gates = DEFAULT_PROMOTION_GATES) {
  const source = shadowTelemetry(projectRoot);
  return createEvaluationReport(source.events, gates, {
    source_kind: "PROJECT_SHADOW_TELEMETRY",
    source_telemetry_sha256: source.sha256,
    source_event_count: source.events.length,
  });
}

export function writeEvaluationReport(projectRoot, report) {
  const path = resolve(projectRoot, EVALUATION_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
  return path;
}

export function createLocalApproval({ report, approvedBy = "HUMAN", note = "" } = {}) {
  if (!report?.eligible_for_retrieval_assist) throw new Error("JEV_REPORT_NOT_ELIGIBLE");
  if (report?.source_kind !== "PROJECT_SHADOW_TELEMETRY") {
    throw new Error("JEV_REPORT_NOT_PROJECT_TELEMETRY");
  }
  const approval = {
    schema: JEV_SCHEMAS.APPROVAL,
    authority: "HUMAN_GATE",
    approved: true,
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
    report_id: report.report_id,
    report_hash: reportHash(report),
    source_telemetry_sha256: report.source_telemetry_sha256,
    note: String(note || "").slice(0, 500),
  };
  approval.approval_id = contentId("jev-approval", approval);
  return approval;
}

export function writeLocalApproval(projectRoot, approval) {
  const path = resolve(projectRoot, APPROVAL_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(approval, null, 2), "utf8");
  return path;
}

export function loadStoredEvaluation(projectRoot) {
  return readJson(resolve(projectRoot, EVALUATION_PATH), null);
}

export function checkRetrievalAssistGate({
  projectRoot,
  env = process.env,
} = {}) {
  const reasons = [];
  if (env.ORCHESTRA_JEV_RETRIEVAL_ASSIST !== "1") reasons.push("FEATURE_FLAG_DISABLED");

  const report = loadStoredEvaluation(projectRoot);
  if (!report) {
    reasons.push("EVALUATION_REPORT_MISSING");
  } else {
    if (report.schema !== JEV_SCHEMAS.EVALUATION) reasons.push("EVALUATION_REPORT_INVALID_SCHEMA");
    if (report.source_kind !== "PROJECT_SHADOW_TELEMETRY") reasons.push("EVALUATION_REPORT_NOT_PROJECT_TELEMETRY");
    if (!report.eligible_for_retrieval_assist) reasons.push("REPORT_NOT_ELIGIBLE");
    const source = shadowTelemetry(projectRoot);
    if (report.source_telemetry_sha256 !== source.sha256) reasons.push("SHADOW_TELEMETRY_CHANGED");
    if (report.source_event_count !== source.events.length) reasons.push("SHADOW_EVENT_COUNT_CHANGED");
  }

  const approvalPath = resolve(projectRoot, APPROVAL_PATH);
  const approval = existsSync(approvalPath) ? readJson(approvalPath, null) : null;
  if (!approval) {
    reasons.push("HUMAN_APPROVAL_MISSING");
  } else if (report) {
    if (approval.schema !== JEV_SCHEMAS.APPROVAL || approval.approved !== true) reasons.push("HUMAN_APPROVAL_INVALID");
    if (approval.report_id !== report.report_id) reasons.push("REPORT_ID_MISMATCH");
    if (approval.report_hash !== reportHash(report)) reasons.push("REPORT_HASH_MISMATCH");
    if (approval.source_telemetry_sha256 !== report.source_telemetry_sha256) reasons.push("TELEMETRY_HASH_MISMATCH");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    approval,
    report,
    authority: "NONE",
  };
}
