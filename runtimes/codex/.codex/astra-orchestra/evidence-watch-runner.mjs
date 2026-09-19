import {
  ensureEvidenceWatch,
  getEvidenceWatch,
  noteEvidenceWatchResult,
  shouldPollEvidenceWatch,
  summarizeEvidenceWatches,
} from "./evidence-watch.mjs";
import { collectCodexRemoteCiEvidence } from "./evidence-collectors.mjs";
import { verifyEvidenceContract } from "./evidence-contract.mjs";

export const CODEX_EVIDENCE_WATCH_RUNNER_SCHEMA = "orchestra.codex-evidence-watch-runner.v1";

/**
 * Provider-native Codex watch step.
 *
 * This deliberately performs no background polling and owns no provider
 * credentials. The Codex session/plugin supplies one factual provider
 * observation; this function binds it to the current task and advances the
 * deterministic watch state. Repeated invocations implement the watch loop.
 */
export function runCodexEvidenceWatchStep({
  activeState,
  scopeContract,
  requirement,
  observation = null,
  nowMs = Date.now(),
} = {}) {
  if (!activeState || !requirement) throw new Error("CODEX_EVIDENCE_WATCH_INPUT_REQUIRED");

  ensureEvidenceWatch(activeState, requirement, nowMs);
  const watch = getEvidenceWatch(activeState, requirement.id);

  if (!observation) {
    return {
      schema: CODEX_EVIDENCE_WATCH_RUNNER_SCHEMA,
      polled: false,
      shouldPoll: shouldPollEvidenceWatch(activeState, requirement.id, nowMs),
      watch,
      summary: summarizeEvidenceWatches(activeState),
    };
  }

  const evidence = collectCodexRemoteCiEvidence({
    requirement,
    observation,
    activeState,
  });
  activeState.evidenceLedger = Array.isArray(activeState.evidenceLedger)
    ? activeState.evidenceLedger
    : [];
  activeState.evidenceLedger.push(evidence);

  noteEvidenceWatchResult(
    activeState,
    requirement.id,
    {
      result: evidence.result,
      reason: evidence.reason,
      evidenceId: evidence.evidenceId,
    },
    nowMs,
  );

  return {
    schema: CODEX_EVIDENCE_WATCH_RUNNER_SCHEMA,
    polled: true,
    evidence,
    watch: getEvidenceWatch(activeState, requirement.id),
    verification: verifyEvidenceContract({
      activeState,
      contract: scopeContract || activeState.scopeContract || {},
      evidenceLedger: activeState.evidenceLedger,
    }),
    summary: summarizeEvidenceWatches(activeState),
  };
}
