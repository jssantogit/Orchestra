import { canonicalize, sha256Canonical } from "./canonical.mjs";
import { DREAM_SCHEMAS } from "./records.mjs";
import {
  DECISION_TYPES,
  WORKER_TIER_ACTIONS,
  INVESTIGATION_STRATEGY_ACTIONS,
  RETRY_ACTIONS,
} from "./action-space.mjs";

export const POLICY_STATUS = Object.freeze({
  OK: "OK",
  POLICY_CONFLICT: "POLICY_CONFLICT",
  POLICY_INVALID_ACTION: "POLICY_INVALID_ACTION",
  NO_MATCHING_RULE: "NO_MATCHING_RULE",
  INVALID_POLICY: "INVALID_POLICY",
});

export const MAX_POLICY_RULES = 128;
export const MAX_POLICY_BYTES = 65536; // 64 KiB

const VALID_DECISION_TYPES_SET = new Set(Object.values(DECISION_TYPES));

const VALID_ACTIONS_BY_DECISION_TYPE = Object.freeze({
  [DECISION_TYPES.WORKER_TIER]: new Set(WORKER_TIER_ACTIONS),
  [DECISION_TYPES.INVESTIGATION_STRATEGY]: new Set(INVESTIGATION_STRATEGY_ACTIONS),
  [DECISION_TYPES.RETRY_ACTION]: new Set(RETRY_ACTIONS),
});

const ALLOWED_WHEN_FIELDS = new Set([
  "task_action",
  "task_domain",
  "criticality",
  "complexity",
  "state",
  "attempt",
  "retry_remaining",
  "retry_reason",
  "post_investigation",
  "evidence",
]);

const ALLOWED_TOP_LEVEL_PROPERTIES = new Set([
  "schema",
  "policy_id",
  "base_policy",
  "description",
  "created_at",
  "rules",
]);

const ALLOWED_RULE_PROPERTIES = new Set([
  "id",
  "decision_type",
  "priority",
  "when",
  "choose",
  "description",
]);

const VALID_ENUMS = Object.freeze({
  task_action: new Set([
    "ORCHESTRATE",
    "INVESTIGATE",
    "IMPLEMENT",
    "TEST",
    "REVIEW",
    "MECHANICAL_FIX",
    "INTEGRATE",
    "ESCALATE",
    "HEAVY_EXECUTION",
    "DIRECT_ACTION",
  ]),
  task_domain: new Set([
    "CODE",
    "AUTOEQ_ALGORITHM",
    "DSP_CORE",
    "UI",
    "DATA",
    "INFRA",
    "TESTING",
    "DOCS",
    "RESEARCH",
    "ORCHESTRA",
    "GENERAL",
  ]),
  criticality: new Set([
    "NORMAL",
    "MAJOR",
    "CRITICAL",
  ]),
  complexity: new Set([
    "SIMPLE",
    "NORMAL",
    "DIFFICULT",
    "EXPERIMENTAL",
    "MECHANICAL",
    "INTEGRATION",
  ]),
  state: new Set([
    "INTAKE",
    "CLASSIFIED",
    "DIRECT_ACTION",
    "PLANNED",
    "DELEGATED",
    "EXECUTING",
    "EVIDENCE_READY",
    "ACCEPTANCE",
    "INTEGRATING",
    "DONE",
    "BLOCKED",
    "HUMAN_GATE",
    "CRITICAL_REVIEW",
  ]),
  retry_reason: new Set([
    "MISINTERPRETED_REQUIREMENT",
    "INCOMPLETE_IMPLEMENTATION",
    "FAILED_TEST",
    "SCOPE_GAP",
    "MISSING_CONTEXT",
    "INTEGRATION_FAILURE",
  ]),
  evidence_status: new Set(["PASS", "FAIL", "UNKNOWN"]),
  evidence_extended_status: new Set(["PASS", "FAIL", "UNKNOWN", "NOT_REQUIRED"]),
});

const ALLOWED_EVIDENCE_FIELDS = new Set([
  "tests",
  "typecheck",
  "build",
  "scope_check",
  "validation_fresh",
]);

/**
 * Computes deterministic content-addressed policy ID: policy-<sha256(canonical(policy_without_id))>
 *
 * @param {Record<string, unknown>} policy
 * @returns {string} Formatted as "policy-<64-char-lowercase-hex>"
 */
export function computePolicyId(policy) {
  if (!policy || typeof policy !== "object") {
    throw new TypeError("Policy must be a non-null object");
  }
  const { policy_id: _ignored, ...rest } = policy;
  const canonicalHash = sha256Canonical(rest);
  const hashHex = canonicalHash.startsWith("sha256:")
    ? canonicalHash.slice(7)
    : canonicalHash;
  return `policy-${hashHex}`;
}

/**
 * Pure deterministic structural and semantic validator for exploration policies.
 * Enforces all normative constraints of orchestra.exploration-policy.v1.
 *
 * @param {unknown} policy
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePolicy(policy) {
  const errors = [];

  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return { valid: false, errors: ["Policy must be a non-null plain object"] };
  }

  for (const key of Object.keys(policy)) {
    if (!ALLOWED_TOP_LEVEL_PROPERTIES.has(key)) {
      errors.push(`Unrecognized top-level property "${key}"`);
    }
  }

  if (policy.schema !== DREAM_SCHEMAS.POLICY) {
    errors.push(
      `Invalid schema: expected "${DREAM_SCHEMAS.POLICY}", got "${policy.schema}"`
    );
  }

  if (policy.base_policy !== undefined && policy.base_policy !== null && typeof policy.base_policy !== "string") {
    errors.push("base_policy must be a string or null");
  }

  if (policy.description !== undefined && typeof policy.description !== "string") {
    errors.push("description must be a string");
  }

  if (policy.created_at !== undefined && typeof policy.created_at !== "string") {
    errors.push("created_at must be a string");
  }

  // Canonical size ceiling
  try {
    const canonicalStr = canonicalize(policy);
    const byteLength = Buffer.byteLength(canonicalStr, "utf8");
    if (byteLength > MAX_POLICY_BYTES) {
      errors.push(
        `Policy serialized size (${byteLength} bytes) exceeds maximum allowable limit of ${MAX_POLICY_BYTES} bytes (64 KiB)`
      );
    }
  } catch (err) {
    errors.push(`Failed to canonicalize policy: ${err.message}`);
  }

  // Check content-addressed policy_id
  if (typeof policy.policy_id !== "string" || !/^policy-[a-f0-9]{64}$/.test(policy.policy_id)) {
    errors.push('policy_id must be a string matching pattern "^policy-[a-f0-9]{64}$"');
  } else {
    try {
      const expectedId = computePolicyId(policy);
      if (policy.policy_id !== expectedId) {
        errors.push(
          `policy_id mismatch: expected content-addressed "${expectedId}", got "${policy.policy_id}"`
        );
      }
    } catch (err) {
      errors.push(`Failed to compute content-addressed policy_id: ${err.message}`);
    }
  }

  // Check rules array
  if (!Array.isArray(policy.rules)) {
    errors.push("rules must be an array");
    return { valid: false, errors };
  }

  if (policy.rules.length === 0) {
    errors.push("rules array must not be empty");
  }

  if (policy.rules.length > MAX_POLICY_RULES) {
    errors.push(
      `Rule count (${policy.rules.length}) exceeds maximum limit of ${MAX_POLICY_RULES} rules`
    );
  }

  const seenRuleIds = new Set();

  for (let idx = 0; idx < policy.rules.length; idx++) {
    const rule = policy.rules[idx];
    const prefix = `Rule [${idx}]`;

    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
      errors.push(`${prefix}: must be a non-null plain object`);
      continue;
    }

    for (const key of Object.keys(rule)) {
      if (!ALLOWED_RULE_PROPERTIES.has(key)) {
        errors.push(`${prefix}: unrecognized rule property "${key}"`);
      }
    }

    if (rule.description !== undefined && typeof rule.description !== "string") {
      errors.push(`${prefix}: description must be a string`);
    }

    // ID validation
    if (typeof rule.id !== "string" || !rule.id.trim()) {
      errors.push(`${prefix}: id must be a non-empty string`);
    } else {
      if (seenRuleIds.has(rule.id)) {
        errors.push(`${prefix}: duplicate rule id "${rule.id}"`);
      }
      seenRuleIds.add(rule.id);
    }

    // Decision type
    if (!VALID_DECISION_TYPES_SET.has(rule.decision_type)) {
      errors.push(
        `${prefix}: invalid decision_type "${rule.decision_type}". Expected one of: ${[...VALID_DECISION_TYPES_SET].join(", ")}`
      );
    }

    // Priority
    if (!Number.isInteger(rule.priority)) {
      errors.push(`${prefix}: priority must be an integer`);
    }

    // Choose
    if (typeof rule.choose !== "string" || !rule.choose.trim()) {
      errors.push(`${prefix}: choose must be a non-empty action string`);
    } else {
      const allowedActions = VALID_ACTIONS_BY_DECISION_TYPE[rule.decision_type];
      if (allowedActions && !allowedActions.has(rule.choose)) {
        errors.push(
          `${prefix}: invalid action "${rule.choose}" for decision_type "${rule.decision_type}". Expected one of: ${[...allowedActions].join(", ")}`
        );
      }
    }

    // When conditions
    if (typeof rule.when !== "object" || rule.when === null || Array.isArray(rule.when)) {
      errors.push(`${prefix}: when must be a non-null plain object`);
      continue;
    }

    for (const [key, cond] of Object.entries(rule.when)) {
      if (!ALLOWED_WHEN_FIELDS.has(key)) {
        errors.push(`${prefix}: disallowed condition field "${key}" in when`);
        continue;
      }

      // Check for illegal expressions / regex / functions / strings where enum array expected
      if (typeof cond === "function" || typeof cond === "symbol") {
        errors.push(`${prefix}: condition field "${key}" contains executable/unsupported type`);
        continue;
      }

      if (key === "post_investigation") {
        if (typeof cond !== "boolean") {
          errors.push(`${prefix}: post_investigation must be a boolean`);
        }
      } else if (key === "attempt" || key === "retry_remaining") {
        if (typeof cond === "number") {
          if (!Number.isInteger(cond) || cond < 0) {
            errors.push(`${prefix}: numeric condition "${key}" must be a non-negative integer`);
          }
        } else if (Array.isArray(cond)) {
          if (cond.length === 0) {
            errors.push(`${prefix}: numeric condition array "${key}" must not be empty`);
          }
          for (const item of cond) {
            if (!Number.isInteger(item) || item < 0) {
              errors.push(`${prefix}: numeric condition array "${key}" elements must be non-negative integers`);
              break;
            }
          }
        } else if (typeof cond === "object" && cond !== null) {
          if (cond.min === undefined || cond.max === undefined) {
            errors.push(`${prefix}: numeric range "${key}" requires both min and max properties`);
          } else if (!Number.isInteger(cond.min) || cond.min < 0 || !Number.isInteger(cond.max) || cond.max < 0) {
            errors.push(`${prefix}: numeric range "${key}" must have non-negative integer min and max`);
          } else if (cond.min > cond.max) {
            errors.push(`${prefix}: numeric range "${key}" has min (${cond.min}) > max (${cond.max})`);
          }
          for (const rangeKey of Object.keys(cond)) {
            if (rangeKey !== "min" && rangeKey !== "max") {
              errors.push(`${prefix}: numeric range "${key}" contains unrecognized property "${rangeKey}"`);
            }
          }
        } else {
          errors.push(`${prefix}: numeric condition "${key}" must be an integer, array of integers, or { min, max } range`);
        }
      } else if (key === "evidence") {
        if (typeof cond !== "object" || cond === null || Array.isArray(cond)) {
          errors.push(`${prefix}: evidence condition must be an object`);
        } else {
          for (const [evKey, evVal] of Object.entries(cond)) {
            if (!ALLOWED_EVIDENCE_FIELDS.has(evKey)) {
              errors.push(`${prefix}: disallowed evidence condition field "${evKey}"`);
            } else if (evKey === "validation_fresh") {
              if (typeof evVal !== "boolean") {
                errors.push(`${prefix}: evidence.validation_fresh must be a boolean`);
              }
            } else {
              const allowedSet = (evKey === "typecheck" || evKey === "build")
                ? VALID_ENUMS.evidence_extended_status
                : VALID_ENUMS.evidence_status;
              if (!Array.isArray(evVal)) {
                errors.push(`${prefix}: evidence.${evKey} must be an array of enum strings`);
              } else if (evVal.length === 0) {
                errors.push(`${prefix}: evidence.${evKey} array must not be empty`);
              } else {
                for (const item of evVal) {
                  if (typeof item !== "string" || !allowedSet.has(item)) {
                    errors.push(`${prefix}: evidence.${evKey} elements must be valid enum strings: ${[...allowedSet].join(", ")}`);
                    break;
                  }
                }
              }
            }
          }
        }
      } else {
        // Enums (task_action, task_domain, criticality, complexity, state, retry_reason)
        const allowedSet = VALID_ENUMS[key];
        if (!Array.isArray(cond)) {
          errors.push(`${prefix}: enum condition "${key}" must be an array of strings (OR semantics)`);
        } else if (cond.length === 0) {
          errors.push(`${prefix}: enum condition "${key}" array must not be empty`);
        } else {
          for (const item of cond) {
            if (typeof item !== "string" || (allowedSet && !allowedSet.has(item))) {
              errors.push(`${prefix}: enum condition "${key}" elements must be valid enum strings: ${allowedSet ? [...allowedSet].join(", ") : ""}`);
              break;
            }
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Matches a single rule's "when" condition block against policy-visible state.
 * Implements strict semantics:
 * - AND across all declared fields in "when"
 * - Arrays represent OR membership
 * - Numeric ranges { min, max } are inclusive
 * - UNKNOWN remains UNKNOWN: missing/undefined/null state values never match positive expectations
 *
 * @param {Record<string, unknown>} when
 * @param {Record<string, unknown>} state
 * @returns {boolean}
 */
function matchesRuleCondition(when = {}, state = {}) {
  for (const [field, condition] of Object.entries(when)) {
    if (field === "evidence") {
      const stateEv = state.evidence;
      if (!stateEv || typeof stateEv !== "object") return false;

      for (const [evField, evCond] of Object.entries(condition)) {
        if (evField === "validation_fresh") {
          if (typeof stateEv.validation_fresh !== "boolean") return false;
          if (stateEv.validation_fresh !== evCond) return false;
        } else if (Array.isArray(evCond)) {
          const stateVal = stateEv[evField];
          if (stateVal === undefined || stateVal === null) return false;
          if (!evCond.includes(stateVal)) return false;
        } else {
          return false;
        }
      }
      continue;
    }

    if (field === "post_investigation") {
      const stateVal = state.post_investigation;
      if (typeof stateVal !== "boolean") return false;
      if (typeof condition === "boolean") {
        if (stateVal !== condition) return false;
      } else {
        return false;
      }
      continue;
    }

    const stateVal = state[field];

    if (field === "attempt" || field === "retry_remaining") {
      if (stateVal === undefined || stateVal === null || typeof stateVal !== "number") {
        return false;
      }
      if (typeof condition === "number") {
        if (stateVal !== condition) return false;
      } else if (Array.isArray(condition)) {
        if (!condition.includes(stateVal)) return false;
      } else if (typeof condition === "object" && condition !== null) {
        if (stateVal < condition.min || stateVal > condition.max) {
          return false;
        }
      } else {
        return false;
      }
      continue;
    }

    // Enum fields
    if (Array.isArray(condition)) {
      if (stateVal === undefined || stateVal === null) {
        return false;
      }
      if (!condition.includes(stateVal)) {
        return false;
      }
    } else {
      return false;
    }
  }

  return true;
}

/**
 * Pure policy interpreter.
 *
 * Evaluates declarative policy rules against structured decision state within the
 * governance-constrained legal action space.
 *
 * Pure: zero fs, zero network, zero clock, zero LLM, zero telemetry, zero history.
 *
 * @param {{
 *   policy: Record<string, unknown>,
 *   decisionType: string,
 *   state: Record<string, unknown>,
 *   availableActions: string[],
 *   baselineAction: string,
 * }} options
 * @returns {{
 *   ok: boolean,
 *   action: string,
 *   source: string,
 *   policy_id: string | null,
 *   matched_rule_ids: string[],
 *   priority: number | null,
 *   diagnostic: string | null,
 * }}
 */
export function evaluatePolicy({
  policy,
  decisionType,
  state = {},
  availableActions = [],
  baselineAction,
}) {
  const normActions = Array.isArray(availableActions) ? availableActions : [];
  const safeBaseline = typeof baselineAction === "string" ? baselineAction : "";

  // 1. Structural and integrity validation
  const validation = validatePolicy(policy);
  if (!validation.valid) {
    return {
      ok: false,
      action: safeBaseline,
      source: "STATIC_ROUTING_FALLBACK",
      policy_id: policy?.policy_id ?? null,
      matched_rule_ids: [],
      priority: null,
      diagnostic: `INVALID_POLICY: ${validation.errors.join("; ")}`,
    };
  }

  // 2. Filter rules by decision_type
  const candidateRules = policy.rules.filter(
    (rule) => rule && rule.decision_type === decisionType
  );

  if (candidateRules.length === 0) {
    return {
      ok: false,
      action: safeBaseline,
      source: "STATIC_ROUTING_FALLBACK",
      policy_id: policy.policy_id,
      matched_rule_ids: [],
      priority: null,
      diagnostic: POLICY_STATUS.NO_MATCHING_RULE,
    };
  }

  // 3. Find all matching rules
  const matchingRules = candidateRules.filter((rule) =>
    matchesRuleCondition(rule.when, state)
  );

  if (matchingRules.length === 0) {
    return {
      ok: false,
      action: safeBaseline,
      source: "STATIC_ROUTING_FALLBACK",
      policy_id: policy.policy_id,
      matched_rule_ids: [],
      priority: null,
      diagnostic: POLICY_STATUS.NO_MATCHING_RULE,
    };
  }

  // 4. Sort matching rules by priority descending
  matchingRules.sort((a, b) => b.priority - a.priority);
  const highestPriority = matchingRules[0].priority;

  // 5. Collect all rules at the highest priority
  const topPriorityMatches = matchingRules.filter(
    (rule) => rule.priority === highestPriority
  );
  const matchedRuleIds = topPriorityMatches.map((r) => r.id);

  // 6. Check for conflict among highest-priority matches
  const chosenActions = new Set(topPriorityMatches.map((r) => r.choose));
  if (chosenActions.size > 1) {
    return {
      ok: false,
      action: safeBaseline,
      source: "STATIC_ROUTING_FALLBACK",
      policy_id: policy.policy_id,
      matched_rule_ids: matchedRuleIds,
      priority: highestPriority,
      diagnostic: `${POLICY_STATUS.POLICY_CONFLICT}: multiple rules at priority ${highestPriority} chose different actions: [${Array.from(chosenActions).join(", ")}]`,
    };
  }

  const chosenAction = topPriorityMatches[0].choose;

  // 7. Legality validation against governance available_actions
  if (!normActions.includes(chosenAction)) {
    return {
      ok: false,
      action: safeBaseline,
      source: "STATIC_ROUTING_FALLBACK",
      policy_id: policy.policy_id,
      matched_rule_ids: matchedRuleIds,
      priority: highestPriority,
      diagnostic: `${POLICY_STATUS.POLICY_INVALID_ACTION}: chosen action "${chosenAction}" not in legal available_actions [${normActions.join(", ")}]`,
    };
  }

  // 8. Successful evaluation
  return {
    ok: true,
    action: chosenAction,
    source: policy.policy_id || "STATIC_POLICY_V1",
    policy_id: policy.policy_id,
    matched_rule_ids: matchedRuleIds,
    priority: highestPriority,
    diagnostic: null,
  };
}
