import { sha256Canonical } from "./canonical.mjs";
import { validatePolicy } from "./policy-engine.mjs";

export const DREAM_SCHEMAS = Object.freeze({
  SNAPSHOT: "orchestra.snapshot.v1",
  DECISION: "orchestra.decision.v1",
  OUTCOME: "orchestra.outcome.v1",
  WORLD: "orchestra.world.v1",
  POLICY: "orchestra.exploration-policy.v1",
});

const FORBIDDEN_AUTHORITY_FIELDS = new Set([
  "override_governance",
  "retry_budget_override",
  "provider",
  "active_policy",
  "exploration_budget_override",
]);

const VALID_DECISION_TYPES = new Set([
  "WORKER_TIER",
  "INVESTIGATION_STRATEGY",
  "RETRY_ACTION",
]);

const VALID_TERMINAL_STATES = new Set([
  "ACCEPTED",
  "RETRY_REQUIRED",
  "HUMAN_GATE",
  "BLOCKED",
  "FAILED",
  "UNKNOWN",
  "ABORTED",
]);

const VALID_WORLD_STATUSES = new Set([
  "SEALED",
  "WORLD_INCOMPLETE",
  "WORLD_INVALID",
]);

const SHA256_PREFIX = "sha256:";

/**
 * Creates a Dream event with an attached event_hash.
 * The event_hash is calculated over the canonical base object, which excludes event_hash.
 *
 * @param {string} type
 * @param {Record<string, unknown>} fields
 * @returns {Record<string, unknown>}
 */
export function createDreamEvent(type, fields) {
  const { event_hash: _ignored, ...rest } = fields || {};
  const base = { ...rest, type };
  const event_hash = sha256Canonical(base);
  return { ...base, event_hash };
}

function findForbiddenAuthorityFields(obj) {
  const found = [];
  function check(val, path = "") {
    if (val && typeof val === "object") {
      for (const [k, v] of Object.entries(val)) {
        const currentPath = path ? `${path}.${k}` : k;
        if (FORBIDDEN_AUTHORITY_FIELDS.has(k)) {
          found.push(currentPath);
        }
        check(v, currentPath);
      }
    }
  }
  check(obj);
  return found;
}

function normalizeKind(kind) {
  if (kind === DREAM_SCHEMAS.SNAPSHOT || kind === "SNAPSHOT" || kind === "snapshot") return "SNAPSHOT";
  if (kind === DREAM_SCHEMAS.DECISION || kind === "DECISION" || kind === "decision") return "DECISION";
  if (kind === DREAM_SCHEMAS.OUTCOME || kind === "OUTCOME" || kind === "outcome") return "OUTCOME";
  if (kind === DREAM_SCHEMAS.WORLD || kind === "WORLD" || kind === "world") return "WORLD";
  if (kind === DREAM_SCHEMAS.POLICY || kind === "POLICY" || kind === "policy") return "POLICY";
  return null;
}

/**
 * Pure structural validator for Dream records (SNAPSHOT, DECISION, OUTCOME, WORLD).
 *
 * @param {string} kind
 * @param {unknown} value
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateDreamRecord(kind, value) {
  const errors = [];
  const normalized = normalizeKind(kind);

  if (!normalized) {
    return { valid: false, errors: [`Unknown Dream record kind: "${kind}"`] };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { valid: false, errors: ["Record must be a non-null object"] };
  }

  // Explicitly check and reject unexpected authority escalation fields
  const forbidden = findForbiddenAuthorityFields(value);
  if (forbidden.length > 0) {
    for (const f of forbidden) {
      errors.push(`Rejected unexpected authority escalation field: "${f}"`);
    }
  }

  switch (normalized) {
    case "SNAPSHOT": {
      if (value.schema !== DREAM_SCHEMAS.SNAPSHOT) {
        errors.push(`Invalid schema: expected "${DREAM_SCHEMAS.SNAPSHOT}", got "${value.schema}"`);
      }
      if (typeof value.snapshot_id !== "string" || !value.snapshot_id.startsWith(SHA256_PREFIX)) {
        errors.push('snapshot_id must be a string starting with "sha256:"');
      }
      const fingerprints = [
        "task_fingerprint",
        "contract_fingerprint",
        "runtime_fingerprint",
        "workspace_fingerprint",
        "environment_fingerprint",
        "execution_state_identity",
        "evidence_fingerprint",
      ];
      for (const fp of fingerprints) {
        const val = value[fp];
        const isStr = typeof val === "string" && val.length > 0;
        const isObj = typeof val === "object" && val !== null;
        if (!isStr && !isObj) {
          errors.push(`${fp} must be a non-empty string or object`);
        }
      }
      break;
    }

    case "DECISION": {
      if (value.schema !== DREAM_SCHEMAS.DECISION) {
        errors.push(`Invalid schema: expected "${DREAM_SCHEMAS.DECISION}", got "${value.schema}"`);
      }
      if (typeof value.decision_id !== "string" || value.decision_id.length === 0) {
        errors.push("decision_id must be a non-empty string");
      }
      if (typeof value.snapshot_id !== "string" || !value.snapshot_id.startsWith(SHA256_PREFIX)) {
        errors.push('snapshot_id must be a string starting with "sha256:"');
      }
      if (!VALID_DECISION_TYPES.has(value.decision_type)) {
        errors.push(`Invalid decision_type: "${value.decision_type}". Expected one of: ${[...VALID_DECISION_TYPES].join(", ")}`);
      }
      if (typeof value.state !== "object" || value.state === null) {
        errors.push("state must be a non-null object");
      }
      if (!Array.isArray(value.available_actions) || value.available_actions.length === 0) {
        errors.push("available_actions must be a non-empty array of strings");
      } else {
        for (const act of value.available_actions) {
          if (typeof act !== "string") {
            errors.push(`available_actions element must be a string, got ${typeof act}`);
          }
        }
      }
      if (typeof value.chosen_action !== "string" || value.chosen_action.length === 0) {
        errors.push("chosen_action must be a non-empty string");
      } else if (Array.isArray(value.available_actions) && !value.available_actions.includes(value.chosen_action)) {
        errors.push(`chosen_action "${value.chosen_action}" is not in available_actions: [${value.available_actions.join(", ")}]`);
      }
      if (typeof value.policy_source !== "string" || value.policy_source.length === 0) {
        errors.push("policy_source must be a non-empty string");
      }
      const isActorStr = typeof value.actor_identity === "string" && value.actor_identity.length > 0;
      const isActorObj = typeof value.actor_identity === "object" && value.actor_identity !== null;
      if (!isActorStr && !isActorObj) {
        errors.push("actor_identity must be a non-empty string or object");
      }
      if (typeof value.created_at !== "string" || value.created_at.length === 0) {
        errors.push("created_at must be a non-empty string");
      }
      break;
    }

    case "OUTCOME": {
      if (value.schema !== DREAM_SCHEMAS.OUTCOME) {
        errors.push(`Invalid schema: expected "${DREAM_SCHEMAS.OUTCOME}", got "${value.schema}"`);
      }
      if (typeof value.decision_id !== "string" || value.decision_id.length === 0) {
        errors.push("decision_id must be a non-empty string");
      }
      if (typeof value.observation_id !== "string" || value.observation_id.length === 0) {
        errors.push("observation_id must be a non-empty string");
      }
      if (typeof value.result !== "string" && (typeof value.result !== "object" || value.result === null)) {
        errors.push("result must be a string or non-null object");
      }
      if (typeof value.evidence_summary !== "object" || value.evidence_summary === null) {
        errors.push("evidence_summary must be a non-null object");
      }
      if (typeof value.retry_state !== "object" || value.retry_state === null) {
        errors.push("retry_state must be a non-null object");
      }
      if (typeof value.cost_metrics !== "object" || value.cost_metrics === null) {
        errors.push("cost_metrics must be a non-null object");
      }
      if (value.terminal_state !== undefined && value.terminal_state !== null) {
        if (!VALID_TERMINAL_STATES.has(value.terminal_state)) {
          errors.push(`Invalid terminal_state: "${value.terminal_state}". Expected one of: ${[...VALID_TERMINAL_STATES].join(", ")}`);
        }
      }
      if (value.resulting_snapshot_id !== undefined && value.resulting_snapshot_id !== null) {
        if (typeof value.resulting_snapshot_id !== "string" || !value.resulting_snapshot_id.startsWith(SHA256_PREFIX)) {
          errors.push('resulting_snapshot_id must be null or a string starting with "sha256:"');
        }
      }
      if (typeof value.created_at !== "string" || value.created_at.length === 0) {
        errors.push("created_at must be a non-empty string");
      }
      break;
    }

    case "WORLD": {
      if (value.schema !== DREAM_SCHEMAS.WORLD) {
        errors.push(`Invalid schema: expected "${DREAM_SCHEMAS.WORLD}", got "${value.schema}"`);
      }
      if (typeof value.world_id !== "string" || value.world_id.length === 0) {
        errors.push("world_id must be a non-empty string");
      }
      if (typeof value.root_snapshot_id !== "string" || !value.root_snapshot_id.startsWith(SHA256_PREFIX)) {
        errors.push('root_snapshot_id must be a string starting with "sha256:"');
      }
      const isRtStr = typeof value.runtime_fingerprint === "string" && value.runtime_fingerprint.length > 0;
      const isRtObj = typeof value.runtime_fingerprint === "object" && value.runtime_fingerprint !== null;
      if (!isRtStr && !isRtObj) {
        errors.push("runtime_fingerprint must be a non-empty string or object");
      }
      if (!Array.isArray(value.event_hashes)) {
        errors.push("event_hashes must be an array of strings");
      } else {
        for (const eh of value.event_hashes) {
          if (typeof eh !== "string" || !eh.startsWith(SHA256_PREFIX)) {
            errors.push('event_hashes elements must be strings starting with "sha256:"');
            break;
          }
        }
      }
      if (typeof value.world_manifest_hash !== "string" || !value.world_manifest_hash.startsWith(SHA256_PREFIX)) {
        errors.push('world_manifest_hash must be a string starting with "sha256:"');
      }
      if (!VALID_WORLD_STATUSES.has(value.status)) {
        errors.push(`Invalid status: "${value.status}". Expected one of: ${[...VALID_WORLD_STATUSES].join(", ")}`);
      }
      if (typeof value.created_at !== "string" || value.created_at.length === 0) {
        errors.push("created_at must be a non-empty string");
      }
      break;
    }

    case "POLICY": {
      const polRes = validatePolicy(value);
      if (!polRes.valid) {
        errors.push(...polRes.errors);
      }
      break;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
