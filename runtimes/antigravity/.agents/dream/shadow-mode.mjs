import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { sha256Canonical } from "./canonical.mjs";
import { POLICY_STATUS, computePolicyId, evaluatePolicy, validatePolicy } from "./policy-engine.mjs";
import { DREAM_SCHEMAS, validateDreamRecord } from "./records.mjs";
import { validateWorld } from "./world-sealer.mjs";

export const SHADOW_CONFIG_SCHEMA = "orchestra.shadow-config.v1";
export const SHADOW_SUPPORT_SCHEMA = "orchestra.shadow-support-index.v1";
export const SHADOW_OBSERVATION_SCHEMA = "orchestra.shadow-observation.v1";
export const SHADOW_REPORT_SCHEMA = "orchestra.shadow-report.v1";

export const SHADOW_GATES = Object.freeze({
  min_eligible_decisions: 50,
  max_unknown_divergence_fraction: 0.20,
});

const ROOT = ".agents/dream-data/shadow";
const POLICY_LAB_ROOT = ".agents/dream-data/policy-lab";
const WORLDS_ROOT = ".agents/dream-data/worlds";
const ALLOWED_CANDIDATE_STATUSES = new Set([
  "RECOMMENDATION_CANDIDATE",
  "IMPROVEMENT_BELOW_MATERIALITY_THRESHOLD",
  "EQUIVALENT",
  "NEEDS_EXPLORATION",
]);

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + "." + process.pid + "." + randomUUID() + ".tmp";
  writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  renameSync(temp, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function configHash(config) {
  const { config_hash: _hash, ...rest } = config || {};
  return sha256Canonical(rest);
}

function supportId(index) {
  const { support_index_id: _id, created_at: _created, ...rest } = index || {};
  return "support-" + sha256Canonical(rest).slice(7);
}

function evaluationId(evaluation) {
  const { evaluation_id: _id, ...rest } = evaluation || {};
  return "evaluation-" + sha256Canonical(rest).slice(7);
}

function observationHash(observation) {
  const { observation_hash: _hash, ...rest } = observation || {};
  return sha256Canonical(rest);
}

function reportId(report) {
  const { report_id: _id, created_at: _created, ...rest } = report || {};
  return "shadow-report-" + sha256Canonical(rest).slice(7);
}

function decisionStateHash(decision) {
  return sha256Canonical(decision?.state || {});
}

function supportKey({ snapshotId, decisionType, stateHash }) {
  return sha256Canonical({
    snapshot_id: snapshotId,
    decision_type: decisionType,
    state_hash: stateHash,
  });
}

function loadWorlds(repoRoot) {
  const dir = resolve(repoRoot, WORLDS_ROOT);
  if (!existsSync(dir)) return { worlds: [], rejected: [] };

  const worlds = [];
  const rejected = [];
  for (const name of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const path = resolve(dir, name);
    let world;
    try {
      world = readJson(path);
    } catch {
      rejected.push({ file: name, reason: "MALFORMED_JSON" });
      continue;
    }
    const valid = validateWorld(world);
    if (!valid.valid) {
      rejected.push({ file: name, reason: "WORLD_INVALID" });
      continue;
    }
    worlds.push(world);
  }
  worlds.sort((a, b) => String(a.world_manifest_hash).localeCompare(String(b.world_manifest_hash)));
  return { worlds, rejected };
}

export function buildShadowSupportIndex(repoRoot) {
  if (!repoRoot) return { ok: false, reason: "MISSING_REPO_ROOT" };
  const loaded = loadWorlds(repoRoot);
  const entries = new Map();

  for (const world of loaded.worlds) {
    const outcomes = new Map((world.outcomes || []).map((o) => [o.decision_id, o]));
    for (const decision of world.decisions || []) {
      const stateHash = decisionStateHash(decision);
      const key = supportKey({
        snapshotId: decision.snapshot_id,
        decisionType: decision.decision_type,
        stateHash,
      });
      const existing = entries.get(key) || {
        snapshot_id: decision.snapshot_id,
        decision_type: decision.decision_type,
        state_hash: stateHash,
        actions: {},
      };
      const action = String(decision.chosen_action || "");
      const stats = existing.actions[action] || {
        observations: 0,
        accepted_observations: 0,
        terminal_outcomes: {},
      };
      stats.observations++;
      const outcome = outcomes.get(decision.decision_id);
      if (outcome?.terminal_state === "ACCEPTED") stats.accepted_observations++;
      const terminal = String(outcome?.terminal_state || "UNKNOWN");
      stats.terminal_outcomes[terminal] = (stats.terminal_outcomes[terminal] || 0) + 1;
      existing.actions[action] = stats;
      entries.set(key, existing);
    }
  }

  const normalizedEntries = {};
  for (const key of [...entries.keys()].sort()) {
    const entry = entries.get(key);
    const actions = {};
    for (const action of Object.keys(entry.actions).sort()) {
      const stats = entry.actions[action];
      actions[action] = {
        observations: stats.observations,
        accepted_observations: stats.accepted_observations,
        terminal_outcomes: Object.fromEntries(
          Object.entries(stats.terminal_outcomes).sort(([a], [b]) => a.localeCompare(b))
        ),
      };
    }
    normalizedEntries[key] = {
      snapshot_id: entry.snapshot_id,
      decision_type: entry.decision_type,
      state_hash: entry.state_hash,
      actions,
    };
  }

  const body = {
    schema: SHADOW_SUPPORT_SCHEMA,
    source_world_manifests: loaded.worlds.map((w) => w.world_manifest_hash).sort(),
    rejected_world_count: loaded.rejected.length,
    entries: normalizedEntries,
  };
  const index = {
    support_index_id: "support-" + sha256Canonical(body).slice(7),
    ...body,
    created_at: new Date().toISOString(),
  };
  const path = resolve(repoRoot, ROOT, "support", index.support_index_id + ".json");
  atomicJson(path, index);
  return { ok: true, index, path, rejected_worlds: loaded.rejected };
}

function validateSupportIndex(index) {
  if (
    !index
    || index.schema !== SHADOW_SUPPORT_SCHEMA
    || typeof index.support_index_id !== "string"
    || !/^support-[a-f0-9]{64}$/.test(index.support_index_id)
    || !index.entries
    || typeof index.entries !== "object"
    || Array.isArray(index.entries)
  ) {
    return { valid: false, reason: "SHADOW_SUPPORT_INVALID" };
  }
  if (supportId(index) !== index.support_index_id) {
    return { valid: false, reason: "SHADOW_SUPPORT_HASH_MISMATCH" };
  }
  return { valid: true };
}

function loadCandidateArtifacts(repoRoot, candidatePolicyId, candidateEvaluationId) {
  const evaluationPath = resolve(
    repoRoot,
    POLICY_LAB_ROOT,
    "evaluations",
    candidateEvaluationId + ".json",
  );
  if (!existsSync(evaluationPath)) return { ok: false, reason: "SHADOW_EVALUATION_MISSING" };

  let evaluation;
  try {
    evaluation = readJson(evaluationPath);
  } catch {
    return { ok: false, reason: "SHADOW_EVALUATION_INVALID" };
  }
  if (
    evaluation?.schema !== "orchestra.policy-lab-evaluation.v1"
    || evaluationId(evaluation) !== evaluation.evaluation_id
    || evaluation.evaluation_id !== candidateEvaluationId
    || evaluation.activation_allowed !== false
  ) {
    return { ok: false, reason: "SHADOW_EVALUATION_INVALID" };
  }

  const evaluated = (evaluation.candidates || []).find(
    (entry) => entry.policy_id === candidatePolicyId
  );
  if (!evaluated || !ALLOWED_CANDIDATE_STATUSES.has(evaluated.status)) {
    return {
      ok: false,
      reason: "SHADOW_CANDIDATE_NOT_ELIGIBLE",
      status: evaluated?.status || null,
    };
  }
  if (candidatePolicyId === evaluation.baseline_policy_id) {
    return { ok: false, reason: "SHADOW_BASELINE_IS_NOT_CANDIDATE" };
  }

  const candidatePath = resolve(
    repoRoot,
    POLICY_LAB_ROOT,
    "candidates",
    candidatePolicyId + ".json",
  );
  if (!existsSync(candidatePath)) return { ok: false, reason: "SHADOW_CANDIDATE_MISSING" };

  let policy;
  try {
    policy = readJson(candidatePath);
  } catch {
    return { ok: false, reason: "SHADOW_CANDIDATE_INVALID" };
  }
  const policyValidation = validatePolicy(policy);
  if (
    !policyValidation.valid
    || policy.policy_id !== candidatePolicyId
    || computePolicyId(policy) !== candidatePolicyId
    || policy.base_policy !== evaluation.baseline_policy_id
  ) {
    return {
      ok: false,
      reason: "SHADOW_CANDIDATE_INVALID",
      errors: policyValidation.errors,
    };
  }

  return {
    ok: true,
    policy,
    evaluation,
    evaluation_entry: evaluated,
    candidate_path: candidatePath,
    evaluation_path: evaluationPath,
  };
}

export function enableShadowMode({
  repoRoot,
  candidatePolicyId,
  evaluationId: candidateEvaluationId,
} = {}) {
  if (!repoRoot || !candidatePolicyId || !candidateEvaluationId) {
    return { enabled: false, reason: "INVALID_SHADOW_ENABLE_INPUT" };
  }

  const candidate = loadCandidateArtifacts(
    repoRoot,
    candidatePolicyId,
    candidateEvaluationId,
  );
  if (!candidate.ok) return { enabled: false, ...candidate };

  const support = buildShadowSupportIndex(repoRoot);
  if (!support.ok) return { enabled: false, ...support };

  const sessionId = "shadow-" + randomUUID();
  const config = {
    schema: SHADOW_CONFIG_SCHEMA,
    shadow_session_id: sessionId,
    enabled: true,
    candidate_policy_id: candidatePolicyId,
    baseline_policy_id: candidate.evaluation.baseline_policy_id,
    evaluation_id: candidateEvaluationId,
    evaluation_status: candidate.evaluation_entry.status,
    support_index_id: support.index.support_index_id,
    created_at: new Date().toISOString(),
  };
  config.config_hash = configHash(config);

  const configPath = resolve(repoRoot, ROOT, "config.json");
  const sessionPath = resolve(repoRoot, ROOT, "sessions", sessionId + ".json");
  atomicJson(sessionPath, config);
  atomicJson(configPath, config);

  return {
    enabled: true,
    config,
    config_path: configPath,
    session_path: sessionPath,
    support_index_path: support.path,
  };
}

export function disableShadowMode(repoRoot) {
  if (!repoRoot) return { disabled: false, reason: "MISSING_REPO_ROOT" };
  const configPath = resolve(repoRoot, ROOT, "config.json");
  try {
    rmSync(configPath, { force: true });
    return { disabled: true };
  } catch (error) {
    return { disabled: false, reason: "SHADOW_DISABLE_FAILED", error: String(error?.message || error) };
  }
}

export function loadShadowConfig(repoRoot) {
  const path = resolve(repoRoot, ROOT, "config.json");
  if (!existsSync(path)) return { active: false, reason: "SHADOW_DISABLED" };
  let config;
  try {
    config = readJson(path);
  } catch {
    return { active: false, reason: "SHADOW_CONFIG_INVALID" };
  }
  if (
    config?.schema !== SHADOW_CONFIG_SCHEMA
    || config.enabled !== true
    || typeof config.shadow_session_id !== "string"
    || !config.shadow_session_id.startsWith("shadow-")
    || typeof config.config_hash !== "string"
    || config.config_hash !== configHash(config)
  ) {
    return { active: false, reason: "SHADOW_CONFIG_INVALID" };
  }
  return { active: true, config, path };
}

function loadRuntimeShadowMaterial(repoRoot, config) {
  const candidatePath = resolve(
    repoRoot,
    POLICY_LAB_ROOT,
    "candidates",
    config.candidate_policy_id + ".json",
  );
  const supportPath = resolve(
    repoRoot,
    ROOT,
    "support",
    config.support_index_id + ".json",
  );
  if (!existsSync(candidatePath) || !existsSync(supportPath)) {
    return { ok: false, reason: "SHADOW_RUNTIME_ARTIFACT_MISSING" };
  }

  let policy, support;
  try {
    policy = readJson(candidatePath);
    support = readJson(supportPath);
  } catch {
    return { ok: false, reason: "SHADOW_RUNTIME_ARTIFACT_INVALID" };
  }

  const policyValidation = validatePolicy(policy);
  const supportValidation = validateSupportIndex(support);
  if (
    !policyValidation.valid
    || policy.policy_id !== config.candidate_policy_id
    || computePolicyId(policy) !== config.candidate_policy_id
    || policy.base_policy !== config.baseline_policy_id
  ) {
    return { ok: false, reason: "SHADOW_RUNTIME_CANDIDATE_INVALID" };
  }
  if (
    !supportValidation.valid
    || support.support_index_id !== config.support_index_id
  ) {
    return { ok: false, reason: supportValidation.reason || "SHADOW_RUNTIME_SUPPORT_INVALID" };
  }
  return { ok: true, policy, support };
}

function validateDecisionEvent(decisionEvent) {
  const validation = validateDreamRecord(DREAM_SCHEMAS.DECISION, decisionEvent);
  if (!validation.valid) return { valid: false, errors: validation.errors };
  const { event_hash: eventHash, ...base } = decisionEvent || {};
  if (!eventHash || sha256Canonical(base) !== eventHash) {
    return { valid: false, errors: ["SHADOW_DECISION_EVENT_HASH_MISMATCH"] };
  }
  return { valid: true };
}

function classifyReplaySupport(support, decisionEvent, candidateAction, divergence) {
  if (!divergence) {
    return {
      status: "SAME_AS_BASELINE",
      observations: null,
      accepted_observations: null,
    };
  }
  const key = supportKey({
    snapshotId: decisionEvent.snapshot_id,
    decisionType: decisionEvent.decision_type,
    stateHash: decisionStateHash(decisionEvent),
  });
  const stats = support.entries?.[key]?.actions?.[candidateAction];
  if (!stats || Number(stats.observations || 0) <= 0) {
    return {
      status: "UNKNOWN_BRANCH",
      observations: 0,
      accepted_observations: 0,
    };
  }
  return {
    status: "EXACT_SUPPORTED",
    observations: Number(stats.observations || 0),
    accepted_observations: Number(stats.accepted_observations || 0),
  };
}

function observationId(config, decisionEvent) {
  return "shadowobs-" + sha256Canonical({
    shadow_session_id: config.shadow_session_id,
    candidate_policy_id: config.candidate_policy_id,
    decision_id: decisionEvent.decision_id,
  }).slice(7);
}

function writeObservation(repoRoot, observation) {
  const path = resolve(
    repoRoot,
    ROOT,
    "observations",
    observation.shadow_session_id,
    observation.observation_id + ".json",
  );
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    let existing;
    try {
      existing = readJson(path);
    } catch {
      return { written: false, reason: "SHADOW_OBSERVATION_CONFLICT", path };
    }
    if (
      existing?.observation_hash === observationHash(existing)
      && existing?.observation_id === observation.observation_id
    ) {
      return { written: true, reused: true, path, observation: existing };
    }
    return { written: false, reason: "SHADOW_OBSERVATION_CONFLICT", path };
  }

  try {
    writeFileSync(path, JSON.stringify(observation, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    return { written: true, reused: false, path, observation };
  } catch (error) {
    if (error?.code === "EEXIST") {
      return writeObservation(repoRoot, observation);
    }
    return {
      written: false,
      reason: "SHADOW_OBSERVATION_WRITE_FAILED",
      error: String(error?.message || error),
    };
  }
}

export function recordShadowObservation({
  repoRoot,
  decisionEvent,
} = {}) {
  if (!repoRoot || !decisionEvent) return { observed: false, reason: "INVALID_SHADOW_OBSERVATION_INPUT" };

  const configResult = loadShadowConfig(repoRoot);
  if (!configResult.active) return { observed: false, reason: configResult.reason };
  const config = configResult.config;

  const decisionValidation = validateDecisionEvent(decisionEvent);
  if (!decisionValidation.valid) {
    return {
      observed: false,
      reason: "SHADOW_DECISION_INVALID",
      errors: decisionValidation.errors,
    };
  }

  const material = loadRuntimeShadowMaterial(repoRoot, config);
  if (!material.ok) return { observed: false, reason: material.reason };

  const baselineAction = String(decisionEvent.chosen_action || "");
  const availableActions = Array.isArray(decisionEvent.available_actions)
    ? [...decisionEvent.available_actions]
    : [];
  const state = decisionEvent.state || {};
  const errors = [];
  let eligible = true;
  let exclusionReason = null;
  let candidateAction = null;
  let evaluation = null;
  let latencyMs = 0;

  if (state.criticality === "CRITICAL") {
    eligible = false;
    exclusionReason = "CRITICAL_EXCLUDED";
  } else if (state.state === "HUMAN_GATE") {
    eligible = false;
    exclusionReason = "HUMAN_GATE_EXCLUDED";
  } else if (!availableActions.includes(baselineAction)) {
    eligible = false;
    exclusionReason = "BASELINE_ACTION_NOT_LEGAL";
  } else {
    const start = performance.now();
    evaluation = evaluatePolicy({
      policy: material.policy,
      decisionType: decisionEvent.decision_type,
      state,
      availableActions,
      baselineAction,
    });
    latencyMs = Math.max(0, performance.now() - start);

    if (evaluation.ok) {
      candidateAction = evaluation.action;
    } else if (evaluation.diagnostic === POLICY_STATUS.NO_MATCHING_RULE) {
      candidateAction = baselineAction;
    } else {
      eligible = false;
      exclusionReason = "CANDIDATE_EVALUATION_ERROR";
      errors.push(String(evaluation.diagnostic || "UNKNOWN_POLICY_ERROR"));
    }
  }

  const divergence = eligible ? candidateAction !== baselineAction : false;
  const replaySupport = eligible
    ? classifyReplaySupport(material.support, decisionEvent, candidateAction, divergence)
    : {
        status: "NOT_EVALUATED",
        observations: null,
        accepted_observations: null,
      };

  const observation = {
    schema: SHADOW_OBSERVATION_SCHEMA,
    observation_id: observationId(config, decisionEvent),
    shadow_session_id: config.shadow_session_id,
    candidate_policy_id: config.candidate_policy_id,
    baseline_policy_id: config.baseline_policy_id,
    evaluation_id: config.evaluation_id,
    support_index_id: config.support_index_id,
    decision_id: decisionEvent.decision_id,
    snapshot_id: decisionEvent.snapshot_id,
    decision_type: decisionEvent.decision_type,
    baseline_action: baselineAction,
    candidate_action: candidateAction,
    divergence,
    replay_support: replaySupport,
    policy_latency_ms: latencyMs,
    eligible,
    exclusion_reason: exclusionReason,
    errors,
    created_at: new Date().toISOString(),
  };
  observation.observation_hash = observationHash(observation);

  const persisted = writeObservation(repoRoot, observation);
  if (!persisted.written) {
    return { observed: false, reason: persisted.reason, error: persisted.error || null };
  }
  return {
    observed: true,
    reused: persisted.reused,
    observation: persisted.observation,
    path: persisted.path,
  };
}

export function recordShadowObservationBestEffort(options = {}) {
  try {
    return recordShadowObservation(options);
  } catch (error) {
    return {
      observed: false,
      reason: "SHADOW_INTERNAL_ERROR",
      error: String(error?.message || error),
    };
  }
}

function percentile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.floor((sorted.length - 1) * q)];
}

export function summarizeShadowSession({ repoRoot, shadowSessionId = null } = {}) {
  if (!repoRoot) return { summarized: false, reason: "MISSING_REPO_ROOT" };

  let sessionId = shadowSessionId;
  let config = null;
  if (!sessionId) {
    const current = loadShadowConfig(repoRoot);
    if (!current.active) return { summarized: false, reason: current.reason };
    sessionId = current.config.shadow_session_id;
    config = current.config;
  } else {
    const sessionPath = resolve(repoRoot, ROOT, "sessions", sessionId + ".json");
    if (!existsSync(sessionPath)) return { summarized: false, reason: "SHADOW_SESSION_MISSING" };
    try {
      config = readJson(sessionPath);
    } catch {
      return { summarized: false, reason: "SHADOW_SESSION_INVALID" };
    }
    if (
      config?.schema !== SHADOW_CONFIG_SCHEMA
      || config.shadow_session_id !== sessionId
      || config.config_hash !== configHash(config)
    ) {
      return { summarized: false, reason: "SHADOW_SESSION_INVALID" };
    }
  }

  const observationsDir = resolve(repoRoot, ROOT, "observations", sessionId);
  const observations = [];
  if (existsSync(observationsDir)) {
    for (const name of readdirSync(observationsDir).filter((x) => x.endsWith(".json")).sort()) {
      let observation;
      try {
        observation = readJson(resolve(observationsDir, name));
      } catch {
        return { summarized: false, reason: "SHADOW_OBSERVATION_INVALID", file: name };
      }
      if (
        observation?.schema !== SHADOW_OBSERVATION_SCHEMA
        || observation.shadow_session_id !== sessionId
        || observation.observation_hash !== observationHash(observation)
      ) {
        return { summarized: false, reason: "SHADOW_OBSERVATION_INVALID", file: name };
      }
      observations.push(observation);
    }
  }

  const eligible = observations.filter((o) => o.eligible === true);
  const divergences = eligible.filter((o) => o.divergence === true);
  const unknownDivergences = divergences.filter(
    (o) => o.replay_support?.status === "UNKNOWN_BRANCH"
  );
  const errorDecisions = observations.filter((o) => Array.isArray(o.errors) && o.errors.length > 0);
  const latencies = eligible.map((o) => Number(o.policy_latency_ms)).filter(Number.isFinite);
  const unknownFraction = divergences.length
    ? unknownDivergences.length / divergences.length
    : 0;

  let status;
  if (errorDecisions.length > 0) {
    status = "SHADOW_BLOCKED";
  } else if (eligible.length < SHADOW_GATES.min_eligible_decisions) {
    status = "COLLECT_MORE_DECISIONS";
  } else if (unknownFraction > SHADOW_GATES.max_unknown_divergence_fraction) {
    status = "GATHER_SUPPORT";
  } else {
    status = "READY_FOR_HUMAN_CANARY_REVIEW";
  }

  const body = {
    schema: SHADOW_REPORT_SCHEMA,
    shadow_session_id: sessionId,
    candidate_policy_id: config.candidate_policy_id,
    baseline_policy_id: config.baseline_policy_id,
    evaluation_id: config.evaluation_id,
    support_index_id: config.support_index_id,
    total_decisions: observations.length,
    eligible_decisions: eligible.length,
    ineligible_decisions: observations.length - eligible.length,
    divergence_count: divergences.length,
    divergence_fraction: eligible.length ? divergences.length / eligible.length : 0,
    unknown_divergence_count: unknownDivergences.length,
    unknown_divergence_fraction: unknownFraction,
    error_decisions: errorDecisions.length,
    critical_exclusions: observations.filter((o) => o.exclusion_reason === "CRITICAL_EXCLUDED").length,
    human_gate_exclusions: observations.filter((o) => o.exclusion_reason === "HUMAN_GATE_EXCLUDED").length,
    policy_latency_ms: {
      p50: percentile(latencies, 0.50),
      p95: percentile(latencies, 0.95),
      max: latencies.length ? Math.max(...latencies) : null,
    },
    gates: {
      min_eligible_decisions: SHADOW_GATES.min_eligible_decisions,
      max_unknown_divergence_fraction: SHADOW_GATES.max_unknown_divergence_fraction,
      eligible_count_met: eligible.length >= SHADOW_GATES.min_eligible_decisions,
      unknown_support_gate_met:
        unknownFraction <= SHADOW_GATES.max_unknown_divergence_fraction,
      zero_errors: errorDecisions.length === 0,
    },
    status,
    activation_allowed: false,
    canary_execution_allowed: false,
    human_approval_required: true,
    next_milestone_required_for_execution: "HUMAN_APPROVED_CANARY",
  };
  const report = {
    report_id: "shadow-report-" + sha256Canonical(body).slice(7),
    ...body,
    created_at: new Date().toISOString(),
  };
  const path = resolve(repoRoot, ROOT, "reports", report.report_id + ".json");
  atomicJson(path, report);
  return { summarized: true, report, path };
}
