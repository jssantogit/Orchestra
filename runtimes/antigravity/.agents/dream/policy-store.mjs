import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Canonical } from "./canonical.mjs";
import { computePolicyId, validatePolicy } from "./policy-engine.mjs";
import { DREAM_SCHEMAS } from "./records.mjs";

export const ACTIVE_POLICY_POINTER_SCHEMA = "orchestra.active-policy-pointer.v1";
export const DREAM_RUNTIME_COMPATIBILITY = Object.freeze({
  snapshot_schema: DREAM_SCHEMAS.SNAPSHOT,
  decision_schema: DREAM_SCHEMAS.DECISION,
  outcome_schema: DREAM_SCHEMAS.OUTCOME,
  policy_schema: DREAM_SCHEMAS.POLICY,
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function durableAtomicJson(path, value) {
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

function staticPolicyPath() {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "policies/static-policy-v1.json",
  );
}

export function loadStaticPolicy() {
  const path = staticPolicyPath();
  if (!existsSync(path)) return { ok: false, reason: "STATIC_POLICY_MISSING", path };
  let policy;
  try {
    policy = readJson(path);
  } catch {
    return { ok: false, reason: "STATIC_POLICY_MALFORMED", path };
  }
  const previousRuntime = loadRuntimePolicy(repoRoot);
  if (!previousRuntime.ok || previousRuntime.diagnostic) {
    return {
      activated: false,
      reason: "POLICY_ACTIVATION_BASELINE_INVALID",
      diagnostic: previousRuntime.diagnostic || previousRuntime.reason || null,
    };
  }
  const previousPolicyId = previousRuntime.policy?.policy_id || null;
  const previousPolicySource = previousRuntime.source || null;

  const validation = validatePolicy(policy);
  if (
    !validation.valid
    || computePolicyId(policy) !== policy.policy_id
  ) {
    return {
      ok: false,
      reason: "STATIC_POLICY_INVALID",
      errors: validation.errors,
      path,
    };
  }
  return { ok: true, policy, path };
}

function activePointerPath(repoRoot) {
  return resolve(repoRoot, ".agents/dream-data/policies/active.json");
}

function versionPath(repoRoot, policyId) {
  return resolve(
    repoRoot,
    ".agents/dream-data/policies/versions",
    policyId + ".json",
  );
}

function pointerHash(pointer) {
  const { pointer_hash: _hash, ...rest } = pointer || {};
  return sha256Canonical(rest);
}

export function validateActivePolicyPointer(pointer) {
  if (
    !pointer
    || pointer.schema !== ACTIVE_POLICY_POINTER_SCHEMA
    || typeof pointer.policy_id !== "string"
    || !/^policy-[a-f0-9]{64}$/.test(pointer.policy_id)
    || pointer.policy_schema !== DREAM_SCHEMAS.POLICY
    || pointer.runtime_compatibility?.snapshot_schema !== DREAM_RUNTIME_COMPATIBILITY.snapshot_schema
    || pointer.runtime_compatibility?.decision_schema !== DREAM_RUNTIME_COMPATIBILITY.decision_schema
    || pointer.runtime_compatibility?.outcome_schema !== DREAM_RUNTIME_COMPATIBILITY.outcome_schema
    || pointer.runtime_compatibility?.policy_schema !== DREAM_RUNTIME_COMPATIBILITY.policy_schema
    || pointer.pointer_hash !== pointerHash(pointer)
    || pointer.promotion?.approved_by !== "HUMAN_EXPLICIT_CLI"
    || typeof pointer.promotion?.canary_report_id !== "string"
  ) {
    return { valid: false, reason: "ACTIVE_POLICY_POINTER_INVALID" };
  }
  return { valid: true };
}

export function loadRuntimePolicy(repoRoot) {
  const staticPolicy = loadStaticPolicy();
  if (!staticPolicy.ok) return staticPolicy;

  if (!repoRoot) {
    return {
      ok: true,
      policy: staticPolicy.policy,
      source: "STATIC_POLICY_V1",
      path: staticPolicy.path,
      active_pointer: null,
      diagnostic: null,
    };
  }

  const pointerPath = activePointerPath(repoRoot);
  if (!existsSync(pointerPath)) {
    return {
      ok: true,
      policy: staticPolicy.policy,
      source: "STATIC_POLICY_V1",
      path: staticPolicy.path,
      active_pointer: null,
      diagnostic: null,
    };
  }

  let pointer;
  try {
    pointer = readJson(pointerPath);
  } catch {
    return {
      ok: true,
      policy: staticPolicy.policy,
      source: "STATIC_ROUTING_FALLBACK",
      path: staticPolicy.path,
      active_pointer: null,
      diagnostic: "ACTIVE_POLICY_POINTER_MALFORMED",
    };
  }
  const pointerValidation = validateActivePolicyPointer(pointer);
  if (!pointerValidation.valid) {
    return {
      ok: true,
      policy: staticPolicy.policy,
      source: "STATIC_ROUTING_FALLBACK",
      path: staticPolicy.path,
      active_pointer: pointer,
      diagnostic: pointerValidation.reason,
    };
  }

  const path = versionPath(repoRoot, pointer.policy_id);
  if (!existsSync(path)) {
    return {
      ok: true,
      policy: staticPolicy.policy,
      source: "STATIC_ROUTING_FALLBACK",
      path: staticPolicy.path,
      active_pointer: pointer,
      diagnostic: "ACTIVE_POLICY_VERSION_MISSING",
    };
  }

  let policy;
  try {
    policy = readJson(path);
  } catch {
    return {
      ok: true,
      policy: staticPolicy.policy,
      source: "STATIC_ROUTING_FALLBACK",
      path: staticPolicy.path,
      active_pointer: pointer,
      diagnostic: "ACTIVE_POLICY_VERSION_MALFORMED",
    };
  }
  const validation = validatePolicy(policy);
  if (
    !validation.valid
    || policy.policy_id !== pointer.policy_id
    || computePolicyId(policy) !== pointer.policy_id
  ) {
    return {
      ok: true,
      policy: staticPolicy.policy,
      source: "STATIC_ROUTING_FALLBACK",
      path: staticPolicy.path,
      active_pointer: pointer,
      diagnostic: "ACTIVE_POLICY_VERSION_INVALID",
    };
  }

  return {
    ok: true,
    policy,
    source: "ACTIVE_POLICY",
    path,
    active_pointer: pointer,
    diagnostic: null,
  };
}

export function activatePolicy({
  repoRoot,
  policy,
  canaryReportId,
  canarySessionId,
} = {}) {
  if (!repoRoot || !policy || !canaryReportId || !canarySessionId) {
    return { activated: false, reason: "INVALID_POLICY_ACTIVATION_INPUT" };
  }
  const validation = validatePolicy(policy);
  if (
    !validation.valid
    || computePolicyId(policy) !== policy.policy_id
  ) {
    return {
      activated: false,
      reason: "POLICY_ACTIVATION_CANDIDATE_INVALID",
      errors: validation.errors,
    };
  }

  const version = versionPath(repoRoot, policy.policy_id);
  durableAtomicJson(version, policy);

  const pointer = {
    schema: ACTIVE_POLICY_POINTER_SCHEMA,
    policy_id: policy.policy_id,
    policy_schema: DREAM_SCHEMAS.POLICY,
    runtime_compatibility: structuredClone(DREAM_RUNTIME_COMPATIBILITY),
    promotion: {
      approved_by: "HUMAN_EXPLICIT_CLI",
      canary_report_id: canaryReportId,
      canary_session_id: canarySessionId,
      promoted_at: new Date().toISOString(),
      previous_policy_id: previousPolicyId,
      previous_policy_source: previousPolicySource,
      activation_reason: "CANARY_PROMOTION",
    },
  };
  pointer.pointer_hash = pointerHash(pointer);

  const pointerPath = activePointerPath(repoRoot);
  durableAtomicJson(pointerPath, pointer);

  const history = {
    schema: "orchestra.policy-activation-event.v1",
    event_id: "policy-activation-" + randomUUID(),
    event_type: "POLICY_PROMOTED",
    policy_id: policy.policy_id,
    previous_policy_id: previousPolicyId,
    pointer_hash: pointer.pointer_hash,
    promotion: structuredClone(pointer.promotion),
    created_at: new Date().toISOString(),
  };
  const historyPath = resolve(
    repoRoot,
    ".agents/dream-data/policies/history",
    history.event_id + ".json",
  );
  durableAtomicJson(historyPath, history);

  return {
    activated: true,
    policy_id: policy.policy_id,
    version_path: version,
    pointer_path: pointerPath,
    history_path: historyPath,
    pointer,
  };
}

export function rollbackActivePolicy({
  repoRoot,
  humanApproval = false,
} = {}) {
  if (!repoRoot) return { rolled_back: false, reason: "MISSING_REPO_ROOT" };
  if (humanApproval !== true) {
    return { rolled_back: false, reason: "EXPLICIT_HUMAN_POLICY_ROLLBACK_REQUIRED" };
  }

  const pointerPath = activePointerPath(repoRoot);
  if (!existsSync(pointerPath)) {
    return { rolled_back: false, reason: "NO_ACTIVE_PROMOTED_POLICY" };
  }

  let pointer;
  try {
    pointer = readJson(pointerPath);
  } catch {
    return { rolled_back: false, reason: "ACTIVE_POLICY_POINTER_MALFORMED" };
  }
  const pointerValidation = validateActivePolicyPointer(pointer);
  if (!pointerValidation.valid) {
    return { rolled_back: false, reason: pointerValidation.reason };
  }

  const staticPolicy = loadStaticPolicy();
  if (!staticPolicy.ok) return { rolled_back: false, reason: staticPolicy.reason };

  const previousPolicyId = pointer.promotion?.previous_policy_id || staticPolicy.policy.policy_id;
  const rollbackOfPolicyId = pointer.policy_id;
  let resultingSource = "STATIC_POLICY_V1";
  let resultingPointer = null;

  if (previousPolicyId === staticPolicy.policy.policy_id) {
    rmSync(pointerPath, { force: true });
  } else {
    const previousPath = versionPath(repoRoot, previousPolicyId);
    if (!existsSync(previousPath)) {
      return { rolled_back: false, reason: "ROLLBACK_POLICY_VERSION_MISSING" };
    }
    let previousPolicy;
    try {
      previousPolicy = readJson(previousPath);
    } catch {
      return { rolled_back: false, reason: "ROLLBACK_POLICY_VERSION_INVALID" };
    }
    const validation = validatePolicy(previousPolicy);
    if (
      !validation.valid
      || previousPolicy.policy_id !== previousPolicyId
      || computePolicyId(previousPolicy) !== previousPolicyId
    ) {
      return {
        rolled_back: false,
        reason: "ROLLBACK_POLICY_VERSION_INVALID",
        errors: validation.errors,
      };
    }

    resultingPointer = {
      schema: ACTIVE_POLICY_POINTER_SCHEMA,
      policy_id: previousPolicyId,
      policy_schema: DREAM_SCHEMAS.POLICY,
      runtime_compatibility: structuredClone(DREAM_RUNTIME_COMPATIBILITY),
      promotion: {
        approved_by: "HUMAN_EXPLICIT_CLI",
        canary_report_id: pointer.promotion.canary_report_id,
        canary_session_id: pointer.promotion.canary_session_id,
        promoted_at: new Date().toISOString(),
        previous_policy_id: rollbackOfPolicyId,
        previous_policy_source: "ACTIVE_POLICY",
        activation_reason: "HUMAN_ROLLBACK",
        rollback_of_policy_id: rollbackOfPolicyId,
      },
    };
    resultingPointer.pointer_hash = pointerHash(resultingPointer);
    durableAtomicJson(pointerPath, resultingPointer);
    resultingSource = "ACTIVE_POLICY";
  }

  const history = {
    schema: "orchestra.policy-activation-event.v1",
    event_id: "policy-rollback-" + randomUUID(),
    event_type: "POLICY_ROLLBACK",
    policy_id: previousPolicyId,
    rollback_of_policy_id: rollbackOfPolicyId,
    approved_by: "HUMAN_EXPLICIT_CLI",
    resulting_source: resultingSource,
    created_at: new Date().toISOString(),
  };
  const historyPath = resolve(
    repoRoot,
    ".agents/dream-data/policies/history",
    history.event_id + ".json",
  );
  durableAtomicJson(historyPath, history);

  return {
    rolled_back: true,
    rollback_of_policy_id: rollbackOfPolicyId,
    policy_id: previousPolicyId,
    source: resultingSource,
    pointer: resultingPointer,
    history_path: historyPath,
  };
}

