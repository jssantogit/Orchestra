# Orchestra Dream Layer Milestone D Corrective Closure Implementation Plan

> **For agentic workers:** Execute task-by-task according to systematic debugging and invariants:
> 1. Reproduce; 2. Trace causal flow; 3. Identify root cause; 4. Write RED test; 5. Confirm RED for expected reason; 6. Make minimal correction; 7. Confirm GREEN; 8. Run related regressions.

**Goal:** Correct all architectural and implementation gaps identified in Milestone D:
1. Real Router Parity (Task 1): Parity verification must test against the real `decideRoute(facts)` -> `classifyBaselineDecision(facts, route)` pipeline across all eligible states instead of mock manual calculations.
2. Real Online Policy Authority (Task 2): Enforce `RECORDED_CHOSEN_ACTION == ACTUAL_EXECUTED_ACTION`. An invocation different from policy must never execute; deny mismatched requests with deterministic expected actions without recording false DECISION events.
3. Three Decision-Point Semantics (Task 3): Implement concrete runtime semantics for `WORKER_TIER`, `INVESTIGATION_STRATEGY`, and `RETRY_ACTION` with congruent execution and deterministic denial gates.
4. Policy Schema Closure (Task 4): Strict alignment between JSON schema (`policy-v1.schema.json`) and `validatePolicy`: 3 decision types, AND between fields, OR enum arrays only, numeric ranges restricted to `attempt` and `retry_remaining` (inclusive), remove `mutation_seq` range from `when` surface, validate action names per `decision_type`.
5. Factual Fallback + Self-Host Isolation (Task 5): Factual fallback recording (`policy_source = STATIC_ROUTING_FALLBACK`, `policy_id`, `baseline_action`, `policy_diagnostic` covering all 9 diagnostic cases) and self-host isolation (resolve active image policy relative to `import.meta.url`, never repository candidate source).
6. Regressions, Two-Key Critical Review, and Closure (Task 6): All 9 required suites passing, clean git diff, documentation updates, commit discipline.

---

## Task Breakdown

### Task 1 — Real Router Parity
- [ ] Reproduce divergence: Minimal RED test with `taskAction = "TEST"`, `implementationComplexity = "difficult"` showing disparity between manual assumption and real router.
- [ ] Align `deriveAvailableActions` and `static-policy-v1.json` to validated router behavior (`TEST` routes to `FLASH_LOW` for simple, and `FLASH_MEDIUM` for normal/difficult/experimental).
- [ ] Recompute `policy_id` for updated `static-policy-v1.json`.
- [ ] Refactor parity verification in `dream.test.mjs` and `routing-policy.test.mjs` to execute real `decideRoute(facts)` -> `classifyBaselineDecision(facts, route)` as the authoritative baseline.
- [ ] Run exhaustive state matrix: `TEST` (SIMPLE, NORMAL, DIFFICULT, EXPERIMENTAL), `MECHANICAL_FIX`, `IMPLEMENT` (SIMPLE, NORMAL, DIFFICULT, EXPERIMENTAL, INTEGRATION, DOCS, post-investigation).
- [ ] Verify metrics: `coverage_percent = 100%`, `parity_percent = 100%`.

### Task 2 — Real Online Policy Authority
- [ ] Reproduce authority gap: Write RED test demonstrating that requested `invoke_subagent` mismatching policy action was previously allowed and recorded with false chosen action.
- [ ] Investigate PreToolUse hook replacement capability: verify argument replacement cannot be assumed transparently without breaking byte-compatibility.
- [ ] Update `pre-tool-enforce.mjs`:
  - Mapping: `FLASH_LOW` -> `flash-low-worker`, `FLASH_MEDIUM` -> `flash-medium-worker`, `FLASH_HIGH` -> `flash-worker`.
  - When requested worker does not match policy action: DENY invocation deterministically (`decision: "deny"`, `reason: "POLICY_MISMATCH: ... expected <action> (<profile>)"`), do NOT record false DECISION.
  - When requested worker matches policy action: ALLOW invocation, record factual DECISION with matching `chosen_action`.
- [ ] Add execution identity test asserting `policy selected action == accepted execution identity == recorded chosen_action`.
- [ ] Confirm GREEN on execution identity tests.

### Task 3 — Three Decision-Point Semantics
- [ ] Add explicit runtime enforcement for the three decision points:
  - `WORKER_TIER`: before worker delegation (`invoke_subagent`), policy selects tier, execution must match.
  - `INVESTIGATION_STRATEGY`: before first mutation of eligible implementation (`mutation_seq === 0`, clean state), if policy chooses `INVESTIGATE_FIRST`, implementation cannot proceed before investigation (deterministic denial gate).
  - `RETRY_ACTION`: when valid `retry_reason` exists and retry budget remains, enforce congruent retry (`RETRY_SAME`, `ESCALATE_WORKER`, `INVESTIGATE_FIRST`, `REPLAN`). Never increase retry budget.
- [ ] Write unit & hook tests: at least one congruence test and one mismatched blocked test for each decision point class.
- [ ] Verify DECISION events are factual immediately pre-action (never fabricated).

### Task 4 — Policy Schema Closure
- [ ] Write RED tests exposing divergences between `policy-v1.schema.json` and `validatePolicy`.
- [ ] Update `policy-v1.schema.json`:
  - Enforce exact allowed actions per `decision_type` (`choose` enum constrained per decision type).
  - Remove `mutation_seq` range from `when` condition schema.
  - Restrict numeric range objects exclusively to `attempt` and `retry_remaining`.
- [ ] Update `policy-engine.mjs`:
  - In `validatePolicy`: validate `rule.choose` against allowed action set for `rule.decision_type`.
  - Disallow range on `mutation_seq` in `when`.
  - Enforce explicit integer priorities and reject same-priority conflicts.
- [ ] Recompute `static-policy-v1.json` hash and verify schema compliance.
- [ ] Confirm all schema closure tests pass GREEN.

### Task 5 — Factual Fallback + Self-Host Isolation
- [ ] Update `schemas/decision-v1.schema.json` to include optional properties: `baseline_action` and `policy_diagnostic`.
- [ ] Update `pre-tool-enforce.mjs`:
  - Resolve static policy from active runtime image via `new URL("../dream/policies/static-policy-v1.json", import.meta.url)` (never candidate repo path).
  - On policy fallback, record factually: `policy_source = "STATIC_ROUTING_FALLBACK"`, `policy_id`, `baseline_action`, `policy_diagnostic`.
  - Handle all 9 diagnostic cases: `MISSING_POLICY`, `MALFORMED_JSON`, `INVALID_POLICY`, `POLICY_HASH_MISMATCH`, `POLICY_CONFLICT`, `POLICY_INVALID_ACTION`, `UNSUPPORTED_SCHEMA`, `INTERPRETER_EXCEPTION`, `NO_MATCHING_RULE`.
- [ ] Write self-host isolation test with temporary fixture modifying candidate source in repo, verifying active runtime image policy is used.
- [ ] Write test covering fallback diagnostic capture.

### Task 6 — Regressions, Critical Review, and Closure
- [ ] Run full regression suites:
  - `npm run test:dream`
  - `npm run test:antigravity`
  - `npm run test:hooks`
  - `npm run test:firewall`
  - `npm run test:turn-economy`
  - `npm run test:installers`
  - `npm run check:contamination`
  - `npm run doctor`
  - `git diff --check`
- [ ] Report isolated real-router parity test metrics (`coverage_percent = 100%`, `parity_percent = 100%`).
- [ ] Update documentation (`docs/dream-layer.md`, `runtimes/antigravity/README.md`).
- [ ] Two-Key Critical Review consensus.
- [ ] Create closure artifact and small git commits per corrective task.
