import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { sha256Canonical } from "./canonical.mjs";
import { evaluatePolicy, POLICY_STATUS, validatePolicy, computePolicyId } from "./policy-engine.mjs";
import { activatePolicy, loadRuntimePolicy } from "./policy-store.mjs";
import {
  CANARY_ROLLOUT_STAGES,
  canAdvanceCanaryRollout,
  canPromoteFinalCanaryStage,
  currentCanaryRolloutStage,
  getCanaryRolloutStage,
  isFinalCanaryRolloutStage,
  nextCanaryRolloutStage,
  rolloutGeneration,
} from "./canary-rollout.mjs";

export const CANARY_CONFIG_SCHEMA = "orchestra.canary-config.v1";
export const CANARY_APPROVAL_SCHEMA = "orchestra.canary-approval.v1";
export const CANARY_EVENT_SCHEMA = "orchestra.canary-event.v1";
export const CANARY_REPORT_SCHEMA = "orchestra.canary-report.v1";
export const CANARY_ROLLOUT_APPROVAL_SCHEMA = "orchestra.canary-rollout-approval.v1";

export const CANARY_GATES = Object.freeze({
  initial_traffic_percent: 5,
  allowed_criticality: "NORMAL",
  rollout_traffic_percents: CANARY_ROLLOUT_STAGES.map((stage) => stage.traffic_percent),
});

const ROOT = ".agents/dream-data/canary";
const POLICY_LAB_ROOT = ".agents/dream-data/policy-lab";
const SHADOW_ROOT = ".agents/dream-data/shadow";

const SAFE_TASK_ACTIONS = new Set(["IMPLEMENT", "TEST", "MECHANICAL_FIX"]);
const SAFE_TASK_DOMAINS = new Set([
  "CODE",
  "UI",
  "DOCS",
  "TESTING",
  "AUTOEQ_ALGORITHM",
  "DSP_CORE",
]);

const CRITICAL_PATH_RE =
  /(?:^|[^a-z])(auth(?:entication|orization)?|security|credential|secret|release|deploy|publish|migration|database|payment|billing|terraform|kubernetes|production|prod\b|\.github\/workflows?)(?:[^a-z]|$)/i;

const EXTERNAL_EFFECT_TOOL_RE =
  /(browser|web|http|url|deploy|publish|release|database|db_|email|mail|slack|discord|cloud|remote|mcp|plugin|connector|send_message)/i;

const EXTERNAL_COMMAND_RE =
  /\b(?:git\s+push|gh\s+(?:release|pr\s+merge)|curl|wget|ssh|scp|rsync|terraform\s+(?:apply|destroy)|kubectl|helm|aws|gcloud|az|docker\s+push|npm\s+publish|pnpm\s+publish)\b/i;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + "." + process.pid + "." + randomUUID() + ".tmp";
  const fd = openSync(temp, "w");
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

function hashWithout(value, fields) {
  const clone = structuredClone(value || {});
  for (const field of fields) delete clone[field];
  return sha256Canonical(clone);
}

function approvalHash(approval) {
  return hashWithout(approval, ["approval_hash"]);
}

function rolloutApprovalHash(approval) {
  return hashWithout(approval, ["rollout_approval_hash"]);
}

function configHash(config) {
  return hashWithout(config, ["config_hash"]);
}

function eventHash(event) {
  return hashWithout(event, ["event_hash"]);
}

function reportId(report) {
  const { report_id: _id, ...rest } = report || {};
  return "canary-report-" + sha256Canonical(rest).slice(7);
}

function shadowReportId(report) {
  const { report_id: _id, ...rest } = report || {};
  return "shadow-report-" + sha256Canonical(rest).slice(7);
}

function supportId(index) {
  const { support_index_id: _id, ...rest } = index || {};
  return "support-" + sha256Canonical(rest).slice(7);
}

function activeConfigPath(repoRoot) {
  return resolve(repoRoot, ROOT, "config.json");
}

function loadShadowReport(repoRoot, reportIdValue) {
  const path = resolve(repoRoot, SHADOW_ROOT, "reports", reportIdValue + ".json");
  if (!existsSync(path)) return { ok: false, reason: "CANARY_SHADOW_REPORT_MISSING" };
  let report;
  try {
    report = readJson(path);
  } catch {
    return { ok: false, reason: "CANARY_SHADOW_REPORT_INVALID" };
  }
  if (
    report?.schema !== "orchestra.shadow-report.v1"
    || report.report_id !== reportIdValue
    || shadowReportId(report) !== reportIdValue
    || report.status !== "READY_FOR_HUMAN_CANARY_REVIEW"
    || report.activation_allowed !== false
    || report.canary_execution_allowed !== false
    || report.human_approval_required !== true
    || report.gates?.eligible_count_met !== true
    || report.gates?.unknown_support_gate_met !== true
    || report.gates?.zero_errors !== true
  ) {
    return { ok: false, reason: "CANARY_SHADOW_REPORT_NOT_READY" };
  }
  return { ok: true, report, path };
}

function loadCandidate(repoRoot, policyId, baselinePolicyId) {
  const path = resolve(repoRoot, POLICY_LAB_ROOT, "candidates", policyId + ".json");
  if (!existsSync(path)) return { ok: false, reason: "CANARY_CANDIDATE_MISSING" };
  let policy;
  try {
    policy = readJson(path);
  } catch {
    return { ok: false, reason: "CANARY_CANDIDATE_INVALID" };
  }
  const validation = validatePolicy(policy);
  if (
    !validation.valid
    || policy.policy_id !== policyId
    || computePolicyId(policy) !== policyId
    || policy.base_policy !== baselinePolicyId
  ) {
    return {
      ok: false,
      reason: "CANARY_CANDIDATE_INVALID",
      errors: validation.errors,
    };
  }
  return { ok: true, policy, path };
}

function loadSupport(repoRoot, supportIndexId) {
  const path = resolve(repoRoot, SHADOW_ROOT, "support", supportIndexId + ".json");
  if (!existsSync(path)) return { ok: false, reason: "CANARY_SUPPORT_INDEX_MISSING" };
  let support;
  try {
    support = readJson(path);
  } catch {
    return { ok: false, reason: "CANARY_SUPPORT_INDEX_INVALID" };
  }
  if (
    support?.schema !== "orchestra.shadow-support-index.v1"
    || support.support_index_id !== supportIndexId
    || supportId(support) !== supportIndexId
  ) {
    return { ok: false, reason: "CANARY_SUPPORT_INDEX_INVALID" };
  }
  return { ok: true, support, path };
}

function appendEvent(repoRoot, sessionId, type, details = {}) {
  const event = {
    schema: CANARY_EVENT_SCHEMA,
    event_id: "canaryev-" + randomUUID(),
    canary_session_id: sessionId,
    type,
    details,
    created_at: new Date().toISOString(),
  };
  event.event_hash = eventHash(event);
  const path = resolve(
    repoRoot,
    ROOT,
    "events",
    sessionId,
    event.event_id + ".json",
  );
  atomicJson(path, event);
  return { event, path };
}

export function approveCanary({
  repoRoot,
  shadowReportId: reportIdValue,
  humanApproval = false,
} = {}) {
  if (!repoRoot || !reportIdValue) {
    return { approved: false, reason: "INVALID_CANARY_APPROVAL_INPUT" };
  }
  if (humanApproval !== true) {
    return { approved: false, reason: "EXPLICIT_HUMAN_APPROVAL_REQUIRED" };
  }

  const shadow = loadShadowReport(repoRoot, reportIdValue);
  if (!shadow.ok) return { approved: false, ...shadow };

  const candidate = loadCandidate(
    repoRoot,
    shadow.report.candidate_policy_id,
    shadow.report.baseline_policy_id,
  );
  if (!candidate.ok) return { approved: false, ...candidate };

  const support = loadSupport(repoRoot, shadow.report.support_index_id);
  if (!support.ok) return { approved: false, ...support };

  const runtimeBaseline = loadRuntimePolicy(repoRoot);
  if (
    !runtimeBaseline.ok
    || runtimeBaseline.diagnostic
    || runtimeBaseline.policy?.policy_id !== shadow.report.baseline_policy_id
  ) {
    return {
      approved: false,
      reason: "CANARY_SHADOW_BASELINE_STALE",
      expected_policy_id: shadow.report.baseline_policy_id,
      observed_policy_id: runtimeBaseline.policy?.policy_id || null,
      diagnostic: runtimeBaseline.diagnostic || runtimeBaseline.reason || null,
    };
  }

  const activePath = activeConfigPath(repoRoot);
  if (existsSync(activePath)) {
    const existing = loadCanaryConfig(repoRoot);
    if (existing.active) {
      return {
        approved: false,
        reason: "CANARY_ALREADY_ACTIVE",
        canary_session_id: existing.config.canary_session_id,
      };
    }
  }

  const approval = {
    schema: CANARY_APPROVAL_SCHEMA,
    approval_id: "canary-approval-" + randomUUID(),
    shadow_report_id: shadow.report.report_id,
    shadow_session_id: shadow.report.shadow_session_id,
    candidate_policy_id: shadow.report.candidate_policy_id,
    baseline_policy_id: shadow.report.baseline_policy_id,
    support_index_id: shadow.report.support_index_id,
    traffic_percent: CANARY_GATES.initial_traffic_percent,
    rollout_stage_index: 0,
    rollout_generation: 0,
    approved_by: "HUMAN_EXPLICIT_CLI",
    created_at: new Date().toISOString(),
  };
  approval.approval_hash = approvalHash(approval);

  const sessionId = "canary-" + randomUUID();
  const config = {
    schema: CANARY_CONFIG_SCHEMA,
    canary_session_id: sessionId,
    status: "ACTIVE",
    approval_id: approval.approval_id,
    approval_hash: approval.approval_hash,
    shadow_report_id: shadow.report.report_id,
    candidate_policy_id: shadow.report.candidate_policy_id,
    baseline_policy_id: shadow.report.baseline_policy_id,
    support_index_id: shadow.report.support_index_id,
    traffic_percent: CANARY_GATES.initial_traffic_percent,
    rollout_stage_index: 0,
    rollout_generation: 0,
    rollout_stage_started_at: new Date().toISOString(),
    rollout_approval_id: null,
    rollout_approval_hash: null,
    previous_rollout_approval_id: null,
    created_at: new Date().toISOString(),
  };
  config.config_hash = configHash(config);

  const approvalPath = resolve(repoRoot, ROOT, "approvals", approval.approval_id + ".json");
  const sessionPath = resolve(repoRoot, ROOT, "sessions", sessionId + ".json");
  atomicJson(approvalPath, approval);
  atomicJson(sessionPath, config);
  atomicJson(activePath, config);

  // Shadow is observation-only. Once a live Canary starts, the active Shadow
  // pointer is removed so candidate decisions are not double-counted as Shadow.
  try { rmSync(resolve(repoRoot, SHADOW_ROOT, "config.json"), { force: true }); } catch {}

  appendEvent(repoRoot, sessionId, "CANARY_APPROVED", {
    approval_id: approval.approval_id,
    shadow_report_id: shadow.report.report_id,
    traffic_percent: CANARY_GATES.initial_traffic_percent,
    rollout_stage_index: 0,
    rollout_generation: 0,
  });

  return {
    approved: true,
    config,
    approval,
    config_path: activePath,
    session_path: sessionPath,
    approval_path: approvalPath,
  };
}

function validateApproval(repoRoot, config) {
  const path = resolve(repoRoot, ROOT, "approvals", config.approval_id + ".json");
  if (!existsSync(path)) return { valid: false, reason: "CANARY_APPROVAL_MISSING" };
  let approval;
  try {
    approval = readJson(path);
  } catch {
    return { valid: false, reason: "CANARY_APPROVAL_INVALID" };
  }
  if (
    approval?.schema !== CANARY_APPROVAL_SCHEMA
    || approval.approval_id !== config.approval_id
    || approval.approval_hash !== config.approval_hash
    || approvalHash(approval) !== approval.approval_hash
    || approval.approved_by !== "HUMAN_EXPLICIT_CLI"
    || approval.candidate_policy_id !== config.candidate_policy_id
    || approval.baseline_policy_id !== config.baseline_policy_id
    || approval.support_index_id !== config.support_index_id
    || approval.traffic_percent !== CANARY_GATES.initial_traffic_percent
  ) {
    return { valid: false, reason: "CANARY_APPROVAL_INVALID" };
  }
  return { valid: true, approval, path };
}

export function loadCanaryConfig(repoRoot) {
  const path = activeConfigPath(repoRoot);
  if (!existsSync(path)) return { active: false, reason: "CANARY_DISABLED" };
  let config;
  try {
    config = readJson(path);
  } catch {
    return { active: false, reason: "CANARY_CONFIG_INVALID" };
  }
  if (
    config?.schema !== CANARY_CONFIG_SCHEMA
    || config.status !== "ACTIVE"
    || typeof config.canary_session_id !== "string"
    || !config.canary_session_id.startsWith("canary-")
    || config.traffic_percent !== CANARY_GATES.initial_traffic_percent
    || config.config_hash !== configHash(config)
  ) {
    return { active: false, reason: "CANARY_CONFIG_INVALID" };
  }
  const approval = validateApproval(repoRoot, config);
  if (!approval.valid) return { active: false, reason: approval.reason };
  return { active: true, config, approval: approval.approval, path };
}

export function deterministicCanarySelection(taskId, candidatePolicyId) {
  if (!taskId || !candidatePolicyId) {
    return { selected: false, bucket: null, reason: "TASK_ID_REQUIRED" };
  }
  const hash = sha256Canonical({
    task_id: String(taskId),
    candidate_policy_id: String(candidatePolicyId),
  }).slice(7);
  const bucket = Number.parseInt(hash.slice(0, 8), 16) % 100;
  return {
    selected: bucket < CANARY_GATES.initial_traffic_percent,
    bucket,
    reason: null,
  };
}

function contractPaths(contract = {}) {
  const allowed = Array.isArray(contract.allowedPaths)
    ? contract.allowedPaths
    : Array.isArray(contract.allowed_paths)
      ? contract.allowed_paths
      : [];
  const forbidden = Array.isArray(contract.forbiddenPaths)
    ? contract.forbiddenPaths
    : Array.isArray(contract.forbidden_paths)
      ? contract.forbidden_paths
      : [];
  return { allowed, forbidden };
}

export function classifyCanaryEligibility({
  taskId,
  state = {},
  activeState = {},
  activeContract = {},
} = {}) {
  if (!taskId) return { eligible: false, reason: "TASK_ID_REQUIRED" };
  if (String(state.criticality || activeState.criticality || "").toUpperCase() !== "NORMAL") {
    return { eligible: false, reason: "CANARY_NORMAL_ONLY" };
  }
  const runtimeState = String(state.state || activeState.state || "").toUpperCase();
  if (runtimeState === "HUMAN_GATE" || runtimeState === "CRITICAL_REVIEW") {
    return { eligible: false, reason: "CANARY_HIGH_RISK_STATE_EXCLUDED" };
  }
  if (activeState.independentReviewRequired === true || activeState.twoKeyReview) {
    return { eligible: false, reason: "CANARY_TWO_KEY_EXCLUDED" };
  }

  const taskAction = String(
    state.task_action || activeState.taskAction || activeState.task_action || ""
  ).toUpperCase();
  if (!SAFE_TASK_ACTIONS.has(taskAction)) {
    return { eligible: false, reason: "CANARY_TASK_ACTION_INELIGIBLE" };
  }

  const taskDomain = String(
    state.task_domain || activeState.taskDomain || activeState.task_domain || ""
  ).toUpperCase();
  if (!SAFE_TASK_DOMAINS.has(taskDomain)) {
    return { eligible: false, reason: "CANARY_TASK_DOMAIN_INELIGIBLE" };
  }

  const taskText = [
    activeState.taskSpec,
    activeState.taskDescription,
    activeState.prompt,
  ].filter(Boolean).join(" ");
  const { allowed, forbidden } = contractPaths(activeContract);
  if (allowed.length === 0) {
    return { eligible: false, reason: "CANARY_SCOPE_CONTRACT_REQUIRED" };
  }
  const scopeText = [...allowed, ...forbidden].join(" ");
  if (CRITICAL_PATH_RE.test(taskText) || CRITICAL_PATH_RE.test(scopeText)) {
    return { eligible: false, reason: "CANARY_CRITICAL_PATH_EXCLUDED" };
  }
  if (
    allowed.some((p) =>
      !p
      || p === "*"
      || p === "**"
      || /^https?:\/\//i.test(String(p))
      || /(?:^|\/)\.agents(?:\/|$)/i.test(String(p))
      || /(?:^|\/)\.github\/workflows(?:\/|$)/i.test(String(p))
    )
  ) {
    return { eligible: false, reason: "CANARY_SCOPE_NOT_LOCAL_REVERSIBLE" };
  }

  return { eligible: true, reason: null };
}

function loadRuntimeMaterial(repoRoot, config) {
  const candidate = loadCandidate(
    repoRoot,
    config.candidate_policy_id,
    config.baseline_policy_id,
  );
  if (!candidate.ok) return candidate;
  const support = loadSupport(repoRoot, config.support_index_id);
  if (!support.ok) return support;
  return { ok: true, policy: candidate.policy, support: support.support };
}

function canaryTaskMarkerPath(repoRoot, taskId) {
  const key = sha256Canonical({ task_id: String(taskId || "") }).slice(7);
  return resolve(repoRoot, ".agents/state/dream/canary-tasks", key + ".json");
}

function markCanaryTaskActive(repoRoot, config, taskId, bucket) {
  const path = canaryTaskMarkerPath(repoRoot, taskId);
  const marker = {
    canary_session_id: config.canary_session_id,
    candidate_policy_id: config.candidate_policy_id,
    task_id: String(taskId),
    bucket,
  };
  if (existsSync(path)) {
    try {
      const existing = readJson(path);
      if (
        existing?.canary_session_id === marker.canary_session_id
        && existing?.candidate_policy_id === marker.candidate_policy_id
        && existing?.task_id === marker.task_id
      ) {
        return { marked: true, reused: true, path, marker: existing };
      }
    } catch {}
  }
  atomicJson(path, marker);
  return { marked: true, reused: false, path, marker };
}

export function evaluateCanaryPolicyOverlay({
  repoRoot,
  taskId,
  decisionType,
  state = {},
  availableActions = [],
  baselineAction,
  baselinePolicyId,
  activeState = {},
  activeContract = {},
} = {}) {
  const current = loadCanaryConfig(repoRoot);
  if (!current.active) return { active: false, reason: current.reason };
  const config = current.config;

  if (baselinePolicyId !== config.baseline_policy_id) {
    rollbackCanary({
      repoRoot,
      trigger: "BASELINE_POLICY_CHANGED",
      details: { expected: config.baseline_policy_id, observed: baselinePolicyId || null },
    });
    return { active: false, reason: "BASELINE_POLICY_CHANGED" };
  }

  const eligibility = classifyCanaryEligibility({
    taskId,
    state,
    activeState,
    activeContract,
  });
  if (!eligibility.eligible) return { active: false, reason: eligibility.reason };

  const selection = deterministicCanarySelection(taskId, config.candidate_policy_id);
  if (!selection.selected) {
    return { active: false, reason: "CANARY_TASK_NOT_SELECTED", bucket: selection.bucket };
  }

  const material = loadRuntimeMaterial(repoRoot, config);
  if (!material.ok) {
    rollbackCanary({ repoRoot, trigger: material.reason || "CANARY_RUNTIME_MATERIAL_INVALID" });
    return { active: false, reason: material.reason || "CANARY_RUNTIME_MATERIAL_INVALID" };
  }

  const start = performance.now();
  let evaluation;
  try {
    evaluation = evaluatePolicy({
      policy: material.policy,
      decisionType,
      state,
      availableActions,
      baselineAction,
    });
  } catch (error) {
    rollbackCanary({
      repoRoot,
      trigger: "CANARY_POLICY_EXCEPTION",
      details: { message: String(error?.message || error) },
    });
    return { active: false, reason: "CANARY_POLICY_EXCEPTION" };
  }
  const latencyMs = Math.max(0, performance.now() - start);

  if (!evaluation.ok && evaluation.diagnostic !== POLICY_STATUS.NO_MATCHING_RULE) {
    const trigger = String(evaluation.diagnostic || "").includes("POLICY_INVALID_ACTION")
      ? "ILLEGAL_ACTION"
      : String(evaluation.diagnostic || "").includes("POLICY_CONFLICT")
        ? "POLICY_CONFLICT"
        : "POLICY_OR_SCHEMA_CORRUPTION";
    rollbackCanary({
      repoRoot,
      trigger,
      details: { diagnostic: evaluation.diagnostic || null },
    });
    return { active: false, reason: trigger };
  }

  const action = evaluation.ok ? evaluation.action : baselineAction;
  markCanaryTaskActive(repoRoot, config, taskId, selection.bucket);
  return {
    active: true,
    selected: true,
    action,
    source: "CANARY_POLICY",
    policy_id: config.candidate_policy_id,
    baseline_action: baselineAction,
    policy_diagnostic: evaluation.ok ? null : POLICY_STATUS.NO_MATCHING_RULE,
    canary_session_id: config.canary_session_id,
    canary_bucket: selection.bucket,
    policy_latency_ms: latencyMs,
  };
}

export function isCanaryTaskSelected({ repoRoot, taskId } = {}) {
  const current = loadCanaryConfig(repoRoot);
  if (!current.active) return { selected: false, reason: current.reason };
  if (!taskId) return { selected: false, reason: "TASK_ID_REQUIRED" };
  const path = canaryTaskMarkerPath(repoRoot, taskId);
  if (!existsSync(path)) return { selected: false, reason: "TASK_NOT_CANARIED" };
  let marker;
  try {
    marker = readJson(path);
  } catch {
    return { selected: false, reason: "CANARY_TASK_MARKER_INVALID" };
  }
  if (
    marker?.canary_session_id !== current.config.canary_session_id
    || marker?.candidate_policy_id !== current.config.candidate_policy_id
    || marker?.task_id !== String(taskId)
  ) {
    return { selected: false, reason: "CANARY_TASK_MARKER_INVALID" };
  }
  return { selected: true, bucket: marker.bucket, marker };
}

export function isCanaryExternalSideEffect({ toolName, toolArgs = {} } = {}) {
  const name = String(toolName || "");
  if (EXTERNAL_EFFECT_TOOL_RE.test(name)) return true;
  if (name === "run_command") {
    const command = String(
      toolArgs.CommandLine || toolArgs.command || toolArgs.cmd || ""
    );
    return EXTERNAL_COMMAND_RE.test(command);
  }
  return false;
}

export function rollbackCanary({
  repoRoot,
  trigger,
  details = {},
} = {}) {
  if (!repoRoot || !trigger) return { rolled_back: false, reason: "INVALID_ROLLBACK_INPUT" };
  const current = loadCanaryConfig(repoRoot);
  if (!current.active) return { rolled_back: false, reason: current.reason };

  const config = current.config;
  const rolledBack = {
    ...config,
    status: "ROLLED_BACK",
    rollback_trigger: trigger,
    rollback_details: details,
    rolled_back_at: new Date().toISOString(),
  };
  rolledBack.config_hash = configHash(rolledBack);

  const sessionPath = resolve(repoRoot, ROOT, "sessions", config.canary_session_id + ".json");
  atomicJson(sessionPath, rolledBack);
  try { rmSync(activeConfigPath(repoRoot), { force: true }); } catch {}
  const event = appendEvent(repoRoot, config.canary_session_id, "CANARY_ROLLED_BACK", {
    trigger,
    details,
  });
  return {
    rolled_back: true,
    trigger,
    canary_session_id: config.canary_session_id,
    event: event.event,
  };
}

export function rollbackSelectedCanaryTask({
  repoRoot,
  taskId,
  trigger,
  details = {},
} = {}) {
  const selected = isCanaryTaskSelected({ repoRoot, taskId });
  if (!selected.selected) return { rolled_back: false, reason: selected.reason || "TASK_NOT_SELECTED" };
  return rollbackCanary({ repoRoot, trigger, details });
}

function stateHash(state) {
  return sha256Canonical(state || {});
}

function supportKey({ snapshotId, decisionType, state }) {
  return sha256Canonical({
    snapshot_id: snapshotId,
    decision_type: decisionType,
    state_hash: stateHash(state),
  });
}

export function registerCanaryDecision({ repoRoot, decisionEvent } = {}) {
  if (!repoRoot || !decisionEvent || decisionEvent.policy_source !== "CANARY_POLICY") {
    return { registered: false, reason: "NOT_CANARY_DECISION" };
  }
  const current = loadCanaryConfig(repoRoot);
  if (!current.active) return { registered: false, reason: current.reason };
  if (decisionEvent.policy_id !== current.config.candidate_policy_id) {
    rollbackCanary({
      repoRoot,
      trigger: "CANARY_DECISION_POLICY_MISMATCH",
      details: { decision_id: decisionEvent.decision_id },
    });
    return { registered: false, reason: "CANARY_DECISION_POLICY_MISMATCH" };
  }

  const marker = {
    canary_session_id: current.config.canary_session_id,
    decision_id: decisionEvent.decision_id,
    snapshot_id: decisionEvent.snapshot_id,
    decision_type: decisionEvent.decision_type,
    state_hash: stateHash(decisionEvent.state),
    baseline_action: decisionEvent.baseline_action,
    candidate_action: decisionEvent.chosen_action,
    policy_id: decisionEvent.policy_id,
    created_at: new Date().toISOString(),
  };
  const path = resolve(
    repoRoot,
    ".agents/state/dream/canary-decisions",
    decisionEvent.decision_id + ".json",
  );
  if (existsSync(path)) {
    try {
      const existing = readJson(path);
      if (
        existing?.canary_session_id === marker.canary_session_id
        && existing?.decision_id === marker.decision_id
        && existing?.policy_id === marker.policy_id
      ) {
        return { registered: true, reused: true, marker: existing, path };
      }
    } catch {}
    return { registered: false, reason: "CANARY_DECISION_MARKER_CONFLICT", path };
  }
  atomicJson(path, marker);
  appendEvent(repoRoot, marker.canary_session_id, "CANARY_DECISION_EXECUTED", {
    decision_id: marker.decision_id,
    snapshot_id: marker.snapshot_id,
    decision_type: marker.decision_type,
    baseline_action: marker.baseline_action,
    candidate_action: marker.candidate_action,
  });
  return { registered: true, reused: false, marker, path };
}

function loadSession(repoRoot, sessionId) {
  const path = resolve(repoRoot, ROOT, "sessions", sessionId + ".json");
  if (!existsSync(path)) return { ok: false, reason: "CANARY_SESSION_MISSING" };
  let session;
  try {
    session = readJson(path);
  } catch {
    return { ok: false, reason: "CANARY_SESSION_INVALID" };
  }
  if (
    session?.schema !== CANARY_CONFIG_SCHEMA
    || session.canary_session_id !== sessionId
    || session.config_hash !== configHash(session)
  ) {
    return { ok: false, reason: "CANARY_SESSION_INVALID" };
  }
  return { ok: true, session, path };
}

export function evaluateCanaryOutcome({
  repoRoot,
  decisionEvent,
  outcomeEvent,
} = {}) {
  if (!repoRoot || !decisionEvent || !outcomeEvent) {
    return { checked: false, reason: "INVALID_CANARY_OUTCOME_INPUT" };
  }
  const markerPath = resolve(
    repoRoot,
    ".agents/state/dream/canary-decisions",
    decisionEvent.decision_id + ".json",
  );
  if (!existsSync(markerPath)) return { checked: false, reason: "NOT_CANARY_DECISION" };

  let marker;
  try {
    marker = readJson(markerPath);
  } catch {
    return rollbackCanary({
      repoRoot,
      trigger: "CANARY_DECISION_MARKER_CORRUPT",
      details: { decision_id: decisionEvent.decision_id },
    });
  }

  const sessionResult = loadSession(repoRoot, marker.canary_session_id);
  if (!sessionResult.ok) {
    return { checked: false, reason: sessionResult.reason };
  }
  const session = sessionResult.session;
  const supportResult = loadSupport(repoRoot, session.support_index_id);
  if (!supportResult.ok) {
    return rollbackCanary({
      repoRoot,
      trigger: supportResult.reason,
      details: { decision_id: decisionEvent.decision_id },
    });
  }

  const key = supportKey({
    snapshotId: marker.snapshot_id,
    decisionType: marker.decision_type,
    state: decisionEvent.state,
  });
  const baselineStats = supportResult.support.entries?.[key]?.actions?.[marker.baseline_action];

  const candidateAccepted = outcomeEvent.terminal_state === "ACCEPTED";
  const baselineExactAccepted = Number(baselineStats?.accepted_observations || 0) > 0;

  appendEvent(repoRoot, marker.canary_session_id, "CANARY_DECISION_OUTCOME", {
    decision_id: decisionEvent.decision_id,
    terminal_state: outcomeEvent.terminal_state || "UNKNOWN",
    baseline_exact_accepted: baselineExactAccepted,
  });

  try { rmSync(markerPath, { force: true }); } catch {}

  if (!candidateAccepted && baselineExactAccepted) {
    const rollback = rollbackCanary({
      repoRoot,
      trigger: "EXACT_PROVEN_REGRESSION",
      details: {
        decision_id: decisionEvent.decision_id,
        snapshot_id: marker.snapshot_id,
        baseline_action: marker.baseline_action,
        candidate_action: marker.candidate_action,
        candidate_terminal_state: outcomeEvent.terminal_state || "UNKNOWN",
      },
    });
    return { checked: true, regression: true, rollback };
  }

  return {
    checked: true,
    regression: false,
    baseline_exact_accepted: baselineExactAccepted,
  };
}

function loadEvents(repoRoot, sessionId) {
  const dir = resolve(repoRoot, ROOT, "events", sessionId);
  if (!existsSync(dir)) return { ok: true, events: [] };
  const events = [];
  for (const name of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    let event;
    try {
      event = readJson(resolve(dir, name));
    } catch {
      return { ok: false, reason: "CANARY_EVENT_INVALID", file: name };
    }
    if (
      event?.schema !== CANARY_EVENT_SCHEMA
      || event.canary_session_id !== sessionId
      || event.event_hash !== eventHash(event)
    ) {
      return { ok: false, reason: "CANARY_EVENT_INVALID", file: name };
    }
    events.push(event);
  }
  return { ok: true, events };
}

export function summarizeCanarySession({ repoRoot, canarySessionId = null } = {}) {
  if (!repoRoot) return { summarized: false, reason: "MISSING_REPO_ROOT" };

  let sessionId = canarySessionId;
  let sessionResult;
  if (sessionId) {
    sessionResult = loadSession(repoRoot, sessionId);
  } else {
    const current = loadCanaryConfig(repoRoot);
    if (!current.active) return { summarized: false, reason: current.reason };
    sessionId = current.config.canary_session_id;
    sessionResult = { ok: true, session: current.config };
  }
  if (!sessionResult.ok) return { summarized: false, reason: sessionResult.reason };

  const eventsResult = loadEvents(repoRoot, sessionId);
  if (!eventsResult.ok) return { summarized: false, reason: eventsResult.reason };
  const events = eventsResult.events;
  const session = sessionResult.session;

  const executed = events.filter((e) => e.type === "CANARY_DECISION_EXECUTED");
  const outcomes = events.filter((e) => e.type === "CANARY_DECISION_OUTCOME");
  const rollbacks = events.filter((e) => e.type === "CANARY_ROLLED_BACK");
  const regressions = rollbacks.filter(
    (e) => e.details?.trigger === "EXACT_PROVEN_REGRESSION"
  );

  let status;
  if (rollbacks.length > 0 || session.status === "ROLLED_BACK") {
    status = "ROLLED_BACK";
  } else if (outcomes.length === 0 || outcomes.length !== executed.length) {
    status = "COLLECT_CANARY_OUTCOMES";
  } else {
    status = "READY_FOR_HUMAN_PROMOTION_REVIEW";
  }

  const body = {
    schema: CANARY_REPORT_SCHEMA,
    canary_session_id: sessionId,
    candidate_policy_id: session.candidate_policy_id,
    baseline_policy_id: session.baseline_policy_id,
    shadow_report_id: session.shadow_report_id,
    traffic_percent: session.traffic_percent,
    executed_canary_decisions: executed.length,
    completed_canary_outcomes: outcomes.length,
    rollback_count: rollbacks.length,
    exact_regression_count: regressions.length,
    status,
    automatic_promotion_allowed: false,
    human_promotion_required: true,
  };
  const report = {
    report_id: "canary-report-" + sha256Canonical(body).slice(7),
    ...body,
  };
  const path = resolve(repoRoot, ROOT, "reports", report.report_id + ".json");
  atomicJson(path, report);
  return { summarized: true, report, path };
}

function loadCanaryReport(repoRoot, canaryReportId) {
  const path = resolve(repoRoot, ROOT, "reports", canaryReportId + ".json");
  if (!existsSync(path)) return { ok: false, reason: "CANARY_REPORT_MISSING" };
  let report;
  try {
    report = readJson(path);
  } catch {
    return { ok: false, reason: "CANARY_REPORT_INVALID" };
  }
  if (
    report?.schema !== CANARY_REPORT_SCHEMA
    || report.report_id !== canaryReportId
    || reportId(report) !== canaryReportId
    || report.status !== "READY_FOR_HUMAN_PROMOTION_REVIEW"
    || report.automatic_promotion_allowed !== false
    || report.human_promotion_required !== true
    || report.rollback_count !== 0
    || report.exact_regression_count !== 0
    || report.completed_canary_outcomes <= 0
    || report.completed_canary_outcomes !== report.executed_canary_decisions
  ) {
    return { ok: false, reason: "CANARY_REPORT_NOT_PROMOTABLE" };
  }
  return { ok: true, report, path };
}

export function promoteCanary({
  repoRoot,
  canaryReportId,
  humanApproval = false,
} = {}) {
  if (!repoRoot || !canaryReportId) {
    return { promoted: false, reason: "INVALID_PROMOTION_INPUT" };
  }
  if (humanApproval !== true) {
    return { promoted: false, reason: "EXPLICIT_HUMAN_PROMOTION_REQUIRED" };
  }

  const reportResult = loadCanaryReport(repoRoot, canaryReportId);
  if (!reportResult.ok) return { promoted: false, ...reportResult };
  const report = reportResult.report;

  const current = loadCanaryConfig(repoRoot);
  if (
    !current.active
    || current.config.canary_session_id !== report.canary_session_id
    || current.config.candidate_policy_id !== report.candidate_policy_id
    || current.config.baseline_policy_id !== report.baseline_policy_id
  ) {
    return { promoted: false, reason: "CANARY_SESSION_NOT_ACTIVE_FOR_REPORT" };
  }

  const runtime = loadRuntimePolicy(repoRoot);
  if (
    !runtime.ok
    || runtime.policy?.policy_id !== report.baseline_policy_id
    || runtime.diagnostic
  ) {
    return {
      promoted: false,
      reason: "PROMOTION_BASELINE_CHANGED_OR_INVALID",
      observed_policy_id: runtime.policy?.policy_id || null,
      diagnostic: runtime.diagnostic || runtime.reason || null,
    };
  }

  const candidate = loadCandidate(
    repoRoot,
    report.candidate_policy_id,
    report.baseline_policy_id,
  );
  if (!candidate.ok) return { promoted: false, ...candidate };

  const activation = activatePolicy({
    repoRoot,
    policy: candidate.policy,
    canaryReportId: report.report_id,
    canarySessionId: report.canary_session_id,
  });
  if (!activation.activated) return { promoted: false, ...activation };

  const promotedSession = {
    ...current.config,
    status: "PROMOTED",
    promoted_policy_id: candidate.policy.policy_id,
    canary_report_id: report.report_id,
    promoted_at: new Date().toISOString(),
  };
  promotedSession.config_hash = configHash(promotedSession);
  const sessionPath = resolve(
    repoRoot,
    ROOT,
    "sessions",
    current.config.canary_session_id + ".json",
  );
  atomicJson(sessionPath, promotedSession);
  try { rmSync(activeConfigPath(repoRoot), { force: true }); } catch {}

  const event = appendEvent(repoRoot, report.canary_session_id, "POLICY_PROMOTED", {
    policy_id: candidate.policy.policy_id,
    canary_report_id: report.report_id,
    pointer_hash: activation.pointer.pointer_hash,
    approved_by: "HUMAN_EXPLICIT_CLI",
  });

  return {
    promoted: true,
    policy_id: candidate.policy.policy_id,
    canary_session_id: report.canary_session_id,
    active_pointer: activation.pointer,
    pointer_path: activation.pointer_path,
    version_path: activation.version_path,
    history_path: activation.history_path,
    event: event.event,
  };
}

