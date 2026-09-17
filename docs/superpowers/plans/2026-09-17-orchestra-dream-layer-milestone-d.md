# Orchestra Dream Layer Milestone D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement and verify Milestone D — Declarative Static Policy — of the approved Orchestra Dream Layer specification: policy schema, deterministic validator, `static-policy-v1.json` declarative baseline, pure policy interpreter, Phase B exhaustive parity shadow testing, Phase C interpreter overlay with static routing fallback, and complete regression verification.

**Architecture:** Extend the AGY-only `.agents/dream/` subsystem with declarative static policy interpretation. Governance builds `available_actions` first; declarative policy selects a legal action; legality validation confirms authorization before execution. If the policy interpreter encounters any mismatch, schema violation, conflict, or error, execution deterministically degrades to the validated static routing router. Exact Replay uses the pure policy interpreter directly as a callback with zero model calls.

**Tech Stack:** Node.js 18+ ESM, built-in `node:test`, `node:assert/strict`, `node:crypto`, `node:fs`, `node:path`, JSON Schema draft-2020-12, existing Antigravity hooks, existing Orchestra routing/state machine governance.

**Spec:** `docs/superpowers/specs/2026-09-17-orchestra-dream-layer-spec.md` (§3, §4.1, §4.2, §5, §6, §7, §8, §9)

---

## Global Constraints

- Implement **only Milestone D**. Do not implement Milestone E+ automatic exploration, candidate generation, mutations, training, or branch materialization.
- Policy evaluation is **100% pure and deterministic**: zero filesystem access during `evaluatePolicy`, zero network, zero clock access, zero LLM calls, zero telemetry reads, zero Dream worlds access, zero source code access, zero raw task prompt visibility.
- Policy schema constraints:
  - AND between fields in `when`.
  - OR only through enum arrays.
  - Numeric ranges only for `attempt` and `retry_remaining` (inclusive `min`/`max`).
  - No regex, no expressions, no JavaScript, no filesystem access, no network access, no time access, no history IDs, no free text conditions.
  - Max 128 rules.
  - Max 64 KiB serialized canonical size.
  - Explicit integer priority in descending order.
  - Conflicts between matches of same priority choosing different actions => `POLICY_CONFLICT` (policy invalid, failover to baseline).
  - Chosen action outside `available_actions` => `POLICY_INVALID_ACTION` (failover to baseline).
  - Content-addressed policy ID: `policy-<sha256(canonical(policy_without_id))>`.
- Parity requirement:
  - Supported state space parity between `static-policy-v1` and baseline router must be **100%** across `WORKER_TIER`, `INVESTIGATION_STRATEGY`, and `RETRY_ACTION`.
- Authority boundary:
  - Policy NEVER creates `available_actions`. Governance derives legal action space first.
  - Overlay is authoritative ONLY for `WORKER_TIER`, `INVESTIGATION_STRATEGY`, and `RETRY_ACTION`.
  - On any policy engine error, failover to static router (`STATIC_ROUTING_FALLBACK`).
- Telemetry attribution:
  - Pre-action `DECISION` record identifies policy source (`STATIC_POLICY_V1` vs `STATIC_ROUTING_FALLBACK` vs `STATIC_ROUTING_CURRENT`).

---

## File Structure

```text
runtimes/antigravity/.agents/dream/
├── schemas/
│   └── policy-v1.schema.json         # JSON Schema draft-2020-12 for orchestra.exploration-policy.v1
├── policies/
│   └── static-policy-v1.json         # Declarative static baseline policy
├── policy-engine.mjs                 # Pure deterministic policy validator & interpreter
├── action-space.mjs                  # Extended/updated for Phase C decision mapping
├── records.mjs                       # Updated to recognize POLICY schema
├── replay-simulator.mjs              # Replay compatibility with policy-engine
└── dream.test.mjs                    # Unit tests, validation tests, parity tests, fallback tests
runtimes/antigravity/.agents/hooks/
└── pre-tool-enforce.mjs              # Phase C interpreter overlay hook integration
runtimes/antigravity/tests/
└── routing-policy.test.mjs           # Baseline and parity test suite
docs/
└── dream-layer.md                    # Documentation update for Milestone D
runtimes/antigravity/
└── README.md                         # Documentation update for Milestone D
```

---

### Task 1: Policy Schema + Deterministic Validation

**Files:**
- Create: `runtimes/antigravity/.agents/dream/schemas/policy-v1.schema.json`
- Modify: `runtimes/antigravity/.agents/dream/records.mjs`
- Create/Test: `runtimes/antigravity/.agents/dream/dream.test.mjs`

- [ ] **Step 1: Create `policy-v1.schema.json`**
Define `orchestra.exploration-policy.v1` schema with constraints:
`schema` const `"orchestra.exploration-policy.v1"`, `policy_id` pattern `^policy-[a-f0-9]{64}$`, optional `base_policy` string, `rules` array (maxItems 128) of rule objects:
- `id`: string, identifier
- `decision_type`: enum `["WORKER_TIER", "INVESTIGATION_STRATEGY", "RETRY_ACTION"]`
- `priority`: integer
- `when`: object with allowed fields (`task_action`, `task_domain`, `criticality`, `complexity`, `state`, `attempt`, `retry_remaining`, `retry_reason`, `mutation_seq`, `post_investigation`, `evidence`)
  - enum fields: array of strings
  - numeric fields (`attempt`, `retry_remaining`, `mutation_seq`): `{ "min": integer, "max": integer }` or array of integers
  - boolean fields (`post_investigation`): boolean or array of booleans
  - `evidence`: object with `tests`, `typecheck`, `build`, `scope_check`, `validation_fresh`
- `choose`: string (must be non-empty action name)

- [ ] **Step 2: Add policy validation in `records.mjs` / `policy-engine.mjs`**
Update `DREAM_SCHEMAS.POLICY = "orchestra.exploration-policy.v1"`.
Implement deterministic structural validator `validatePolicy(policy)`:
- checks schema constant
- checks serialized size <= 65536 bytes (64 KiB)
- checks rule count <= 128
- verifies content-addressed `policy_id` against `sha256Canonical(policy_without_id)`
- enforces no regex / expressions / functions / forbidden properties
- verifies numeric ranges are inclusive with `min <= max`
- verifies rule IDs are unique

- [ ] **Step 3: Unit tests for policy validation**
Prove valid policy passes, invalid policies fail:
- rule count > 128 rejected
- serialized size > 64 KiB rejected
- mismatched hash in `policy_id` rejected
- invalid `decision_type` rejected
- expressions/regex rejected

---

### Task 2: static-policy-v1 Declarative Baseline

**Files:**
- Create: `runtimes/antigravity/.agents/dream/policies/static-policy-v1.json`
- Test: `runtimes/antigravity/.agents/dream/dream.test.mjs`

- [ ] **Step 1: Construct `static-policy-v1.json` rules**
Create explicit declarative rules for:
1. `WORKER_TIER`:
   - High complexity / experimental / integration / post-investigation => `FLASH_HIGH`
   - Simple / mechanical / docs domain => `FLASH_LOW`
   - Normal complexity => `FLASH_MEDIUM`
2. `INVESTIGATION_STRATEGY`:
   - Eligible clean implementation states => `IMPLEMENT_DIRECT` (standard baseline)
3. `RETRY_ACTION`:
   - `FAILED_TEST` => `RETRY_SAME`
   - `INCOMPLETE_IMPLEMENTATION` => `RETRY_SAME`
   - `MISSING_CONTEXT` => `INVESTIGATE_FIRST`
   - `MISINTERPRETED_REQUIREMENT` => `REPLAN`
   - `SCOPE_GAP` => `REPLAN`
   - `INTEGRATION_FAILURE` => `ESCALATE_WORKER`

Compute canonical content-addressed `policy_id`: `policy-<sha256(canonical(policyWithoutId))>`.

- [ ] **Step 2: Add validation test for `static-policy-v1.json`**
Verify `static-policy-v1.json` is structurally valid, strictly matches schema, and content-addressed hash matches.

---

### Task 3: Pure Policy Interpreter

**Files:**
- Create: `runtimes/antigravity/.agents/dream/policy-engine.mjs`
- Test: `runtimes/antigravity/.agents/dream/dream.test.mjs`

- [ ] **Step 1: Implement `evaluatePolicy`**
Signature:
```js
evaluatePolicy({
  policy,
  decisionType,
  state,
  availableActions,
  baselineAction
})
```
Evaluation logic:
1. Validate policy structure (or memoized validation). If invalid => `{ ok: false, action: baselineAction, source: "BASELINE_FALLBACK", diagnostic: "INVALID_POLICY" }`.
2. Filter rules by `rule.decision_type === decisionType`.
3. Sort candidate rules by `priority` descending.
4. Match rule conditions against `state`:
   - Missing fields in `state` remain UNKNOWN (never inferred as false/0/PASS).
   - Array in `when[field]`: `state[field]` must be included.
   - Numeric range in `when[field]`: `when[field].min <= state[field] && state[field] <= when[field].max`.
   - Boolean in `when[field]`: exact equality.
   - Evidence nested conditions: match nested properties.
5. Group matches by highest priority:
   - If highest priority has matches:
     - If all matches choose the same action: candidateAction = matches[0].choose.
     - If matches choose different actions: conflict! Return `{ ok: false, action: baselineAction, source: "BASELINE_FALLBACK", diagnostic: "POLICY_CONFLICT" }`.
6. Legality check:
   - If candidateAction is not in `availableActions`: Return `{ ok: false, action: baselineAction, source: "BASELINE_FALLBACK", diagnostic: "POLICY_INVALID_ACTION" }`.
7. If no matching rule: Return `{ ok: false, action: baselineAction, source: "BASELINE_FALLBACK", diagnostic: "NO_MATCHING_RULE" }`.
8. Success: Return:
```js
{
  ok: true,
  action: candidateAction,
  source: policy.policy_id || "STATIC_POLICY_V1",
  policy_id: policy.policy_id,
  matched_rule_ids: matchingRuleIds,
  priority: highestPriority,
  diagnostic: null
}
```

- [ ] **Step 2: Unit tests for `evaluatePolicy`**
- Matching all fields (AND)
- Enum arrays (OR)
- Numeric ranges (min/max inclusive)
- UNKNOWN remaining UNKNOWN
- Priority descending evaluation
- Conflict handling (`POLICY_CONFLICT`)
- Illegal action handling (`POLICY_INVALID_ACTION`)
- No matching rule fallback

---

### Task 4: Phase B — Exhaustive Parity Shadow

**Files:**
- Modify: `runtimes/antigravity/.agents/dream/dream.test.mjs`
- Modify: `runtimes/antigravity/tests/routing-policy.test.mjs`

- [ ] **Step 1: Construct Exhaustive Parity Shadow Matrix**
Test matrix generating all eligible combinations of:
- `task_action` in `["IMPLEMENT", "TEST", "MECHANICAL_FIX"]`
- `task_domain` in `["CODE", "DOCS", "UI", "DATA", "INFRA", "TESTING", "RESEARCH", "ORCHESTRA", "GENERAL"]`
- `complexity` in `["SIMPLE", "NORMAL", "DIFFICULT", "EXPERIMENTAL", "MECHANICAL", "INTEGRATION"]`
- `criticality` in `["NORMAL", "MAJOR"]`
- `post_investigation` in `[false, true]`
- `mutation_seq` in `[0, 1]`
- `retry_reason` in `RETRY_REASONS`
- `attempt` in `[1, 2]`
- `retry_remaining` in `[0, 1, 2]`

- [ ] **Step 2: Verify 100% Shadow Parity**
Run both `classifyBaselineDecision` / `decideRoute` and `evaluatePolicy` with `static-policy-v1.json`.
Assert:
- `explicit_policy_coverage = 100%`
- `action_parity = 100%`
- Report metric: `eligible_cases`, `explicit_matches`, `action_matches`, `coverage_percent=100`, `parity_percent=100`.

---

### Task 5: Phase C — Interpreter Overlay + Static Fallback

**Files:**
- Modify: `runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs`
- Modify: `runtimes/antigravity/.agents/dream/replay-simulator.mjs`
- Test: `runtimes/antigravity/tests/hooks.test.mjs`
- Test: `runtimes/antigravity/.agents/dream/dream.test.mjs`

- [ ] **Step 1: Integrate Interpreter Overlay in `pre-tool-enforce.mjs`**
In `pre-tool-enforce.mjs`:
- For eligible decisions (`WORKER_TIER`, `INVESTIGATION_STRATEGY`, `RETRY_ACTION`):
  1. Governance derives legal `available_actions`.
  2. Compute `baselineDecision`.
  3. Load `static-policy-v1.json`.
  4. Call `evaluatePolicy(...)`.
  5. If `evalResult.ok`:
     - chosen action is `evalResult.action`.
     - policy_source is `STATIC_POLICY_V1`.
  6. If not `evalResult.ok`:
     - fallback to `baselineDecision.chosenAction`.
     - policy_source is `STATIC_ROUTING_FALLBACK`.
- Write `DECISION` record with correct policy source.
- Fallback guarantees zero interruption to healthy tasks.

- [ ] **Step 2: Integrate Replay Simulator with Policy Engine**
Verify `replayExact` works seamlessly with `evaluatePolicy` callback with zero model calls.

- [ ] **Step 3: Verification of Fallback and Safety Invariants**
Add tests:
- Corrupted policy file -> fallback to static router, task succeeds.
- Conflict policy -> fallback to static router.
- Illegal action candidate -> fallback to static router.
- Action legality strictly validated against `available_actions`.
- DECISION record accurately attributes `STATIC_POLICY_V1` vs `STATIC_ROUTING_FALLBACK`.

---

### Task 6: Integration, Regression, Documentation, Closure

**Files:**
- Modify: `docs/dream-layer.md`
- Modify: `runtimes/antigravity/README.md`
- Create: Closure summary artifact in brain directory

- [ ] **Step 1: Run Full Test and Regression Battery**
Run:
- `npm run test:dream`
- `npm run test:antigravity`
- `npm run test:hooks`
- `npm run test:firewall`
- `npm run test:turn-economy`
- `npm run test:installers`
- `npm run check:contamination`
- `npm run doctor`
- `git diff --check`

- [ ] **Step 2: Update Documentation**
Update `docs/dream-layer.md` and `runtimes/antigravity/README.md` reflecting Milestone D:
- Declarative static policy engine
- Policy schema `orchestra.exploration-policy.v1`
- `static-policy-v1.json`
- Parity shadow & interpreter overlay architecture

- [ ] **Step 3: Self-Host Health Check & Final Commit**
Verify self-host status and git status.
Commit per accepted unit.

---
