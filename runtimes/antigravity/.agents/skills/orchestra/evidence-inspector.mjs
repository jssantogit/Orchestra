import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { explainEvidenceContract } from "./evidence-contract.mjs";
import { readEvidenceGitContext } from "./evidence-federation.mjs";
import { summarizeEvidenceWatches } from "./evidence-watch.mjs";

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

export function inspectProjectEvidence(targetDir) {
  const root = resolve(targetDir);
  const statePath = join(root, ".agents", "state", "active-state.json");
  const contractPath = join(root, ".agents", "state", "active-contract.json");

  if (!existsSync(statePath)) {
    return {
      available: false,
      status: "NO_ACTIVE_STATE",
      targetDir: root,
      task: null,
      evidence: null,
    };
  }

  const activeState = readJson(statePath, null);
  if (!activeState) {
    return {
      available: false,
      status: "ACTIVE_STATE_UNREADABLE",
      targetDir: root,
      task: null,
      evidence: null,
    };
  }

  const contract = readJson(contractPath, null) || activeState.scopeContract || {};
  const git = readEvidenceGitContext(root);
  const inspectionState = structuredClone(activeState);
  if (git.headSha) inspectionState.evidenceCandidateHead = git.headSha;

  const evidence = explainEvidenceContract({
    activeState: inspectionState,
    contract,
    evidenceLedger: inspectionState.evidenceLedger || [],
  });

  return {
    available: true,
    status: evidence.status,
    targetDir: root,
    task: {
      taskId: activeState.taskId || activeState.taskKey || null,
      state: activeState.state || null,
      acceptanceState: activeState.acceptanceState || null,
      taskAction: activeState.taskAction || null,
      criticality: activeState.criticality || null,
      attempt: Number.isInteger(activeState.attempt) ? activeState.attempt : 0,
      mutationSeq: typeof activeState.mutationSeq === "number" ? activeState.mutationSeq : 0,
      candidateHead: git.headSha || null,
      trackedDirty: git.trackedDirty,
    },
    evidence,
    runtimeSignals: {
      lastEvidenceCollection: activeState.lastEvidenceCollection || null,
      lastEvidenceFederation: activeState.lastEvidenceFederation || null,
      lastEvidenceBindingFinalization: activeState.lastEvidenceBindingFinalization || null,
      evidenceFailure: activeState.evidenceFailure || null,
      evidenceStale: activeState.evidenceStale || null,
      ciWait: activeState.ciWait || null,
      evidenceWatches: summarizeEvidenceWatches(activeState),
      lastStopBlockedReason: activeState.lastStopBlockedReason || null,
      stopBlockedCount: activeState.stopBlockedCount || 0,
      humanGateReason: activeState.humanGateReason || null,
    },
  };
}

function short(value, n = 12) {
  if (!value) return "-";
  const s = String(value);
  return s.length > n ? s.slice(0, n) : s;
}

export function formatEvidenceInspection(report) {
  if (!report.available) {
    return [
      "Orchestra Evidence Status",
      "Target: " + report.targetDir,
      "Status: " + report.status,
    ].join("\n");
  }

  const lines = [];
  lines.push("==================================================");
  lines.push(" Orchestra Evidence Status");
  lines.push("==================================================");
  lines.push("Target:      " + report.targetDir);
  lines.push("Task:        " + (report.task.taskId || "-"));
  lines.push("State:       " + (report.task.state || "-"));
  lines.push("Acceptance:  " + (report.task.acceptanceState || "-"));
  lines.push("Attempt:     " + report.task.attempt);
  lines.push("Mutation:    " + report.task.mutationSeq);
  lines.push("HEAD:        " + (report.task.candidateHead || "-"));
  lines.push("Dirty:       " + String(report.task.trackedDirty));
  lines.push("Evidence:    " + report.evidence.status);
  if (report.evidence.reason) lines.push("Reason:      " + report.evidence.reason);
  lines.push("");

  if (report.evidence.requirements.length === 0) {
    lines.push("No evidence requirements.");
  }

  for (const req of report.evidence.requirements) {
    lines.push("[" + req.status + "] " + req.id + "  " + req.kind + "/" + req.class);
    if (req.reason) lines.push("  reason: " + req.reason);
    lines.push("  candidates: " + req.candidateCount);
    for (const candidate of req.candidates) {
      const who = candidate.producer?.role || candidate.provider || "-";
      const source = candidate.producer?.source || candidate.provenance?.source || "-";
      const bind = candidate.binding || {};
      lines.push(
        "    - " + (candidate.status || "UNKNOWN")
        + " reason=" + (candidate.reason || "-")
        + " id=" + short(candidate.evidenceId, 18)
      );
      lines.push(
        "      producer=" + who
        + " source=" + source
        + " task=" + (bind.taskId || "-")
        + " attempt=" + (bind.attempt ?? "-")
        + " mutation=" + (bind.mutationSeq ?? "-")
        + " commit=" + short(bind.commitSha || candidate.run?.headSha || "-", 12)
      );
      if (candidate.command) lines.push("      command=" + candidate.command);
      if (candidate.run?.id) {
        lines.push(
          "      ci_run=" + candidate.run.id
          + " status=" + (candidate.run.status || "-")
          + " conclusion=" + (candidate.run.conclusion || "-")
        );
      }
    }
    lines.push("");
  }

  if (report.runtimeSignals.evidenceWatches?.count > 0) {
    lines.push("Evidence watches:");
    for (const watch of report.runtimeSignals.evidenceWatches.watches) {
      lines.push(
        "  " + watch.requirementId
        + " provider=" + watch.provider
        + " status=" + watch.status
        + " polls=" + watch.pollCount
        + " next=" + (watch.nextPollAt || "-")
        + " deadline=" + (watch.deadlineAt || "-")
      );
    }
  }
  if (report.runtimeSignals.ciWait) {
    lines.push("CI_WAIT: " + JSON.stringify(report.runtimeSignals.ciWait));
  }
  if (report.runtimeSignals.lastStopBlockedReason) {
    lines.push(
      "Stop Guard: " + report.runtimeSignals.lastStopBlockedReason
      + " (count=" + report.runtimeSignals.stopBlockedCount + ")"
    );
  }
  if (report.runtimeSignals.humanGateReason) {
    lines.push("Human Gate: " + report.runtimeSignals.humanGateReason);
  }

  return lines.join("\n").trimEnd();
}
