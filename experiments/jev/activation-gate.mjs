import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  JEV_AUTHORITY,
  JEV_SCHEMAS,
  canonicalJson,
  contentId,
  sha256,
} from "./schemas.mjs";
import { DEFAULT_PROMOTION_GATES, evaluateForRetrievalAssist } from "./evaluator.mjs";

export const APPROVAL_PATH = ".agents/semantic/jev-approval.json";

export function reportHash(report) {
  return sha256(report);
}

export function createEvaluationReport(runs, gates = DEFAULT_PROMOTION_GATES) {
  return evaluateForRetrievalAssist(runs, gates);
}

export function createLocalApproval({ report, approvedBy = "HUMAN", note = "" } = {}) {
  if (!report?.eligible_for_retrieval_assist) throw new Error("JEV_REPORT_NOT_ELIGIBLE");
  const approval = {
    schema: JEV_SCHEMAS.APPROVAL,
    authority: "HUMAN_GATE",
    approved: true,
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
    report_id: report.report_id,
    report_hash: reportHash(report),
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

export function checkRetrievalAssistGate({
  projectRoot,
  report,
  env = process.env,
} = {}) {
  const reasons = [];
  if (env.ORCHESTRA_JEV_RETRIEVAL_ASSIST !== "1") reasons.push("FEATURE_FLAG_DISABLED");
  if (!report?.eligible_for_retrieval_assist) reasons.push("REPORT_NOT_ELIGIBLE");

  const path = resolve(projectRoot, APPROVAL_PATH);
  let approval = null;
  if (!existsSync(path)) {
    reasons.push("HUMAN_APPROVAL_MISSING");
  } else {
    try { approval = JSON.parse(readFileSync(path, "utf8")); }
    catch { reasons.push("HUMAN_APPROVAL_INVALID_JSON"); }
  }

  if (approval) {
    if (approval.schema !== JEV_SCHEMAS.APPROVAL || approval.approved !== true) reasons.push("HUMAN_APPROVAL_INVALID");
    if (approval.report_id !== report?.report_id) reasons.push("REPORT_ID_MISMATCH");
    if (approval.report_hash !== reportHash(report)) reasons.push("REPORT_HASH_MISMATCH");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    approval,
    authority: JEV_AUTHORITY,
  };
}
