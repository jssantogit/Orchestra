# Orchestra Dream Layer Milestone D Final Corrective Closure Plan

> **For agentic workers:** Execute task-by-task according to strict execution invariants:
> 1. Reproduce; 2. Trace causal flow; 3. Identify root cause; 4. Write RED test; 5. Confirm RED for expected reason; 6. Make minimal correction; 7. Confirm GREEN; 8. Run regressions; 9. Commit.

**Goal:** Complete the final corrective closure of Orchestra Dream Layer Milestone D:
1. **Independent Baseline + Action-Leakage Removal (Task 1)**: Invariant: Candidate action must never participate in the features used to decide that same action. Static baseline and fallback must be pure, production-authoritative, and independent of requested profile.
2. **Causal Decision-Point Closure & Three-Class Real Parity (Task 2)**: All 3 decision classes (`WORKER_TIER`, `INVESTIGATION_STRATEGY`, `RETRY_ACTION`) share a single authoritative flow. DECISION is strictly recorded immediately before factual execution; blocked requests establish ephemeral requirements without fabricated decisions.
3. **Policy Contract Equivalence & Retry Semantics (Task 3)**: Exact bidirectional contract equivalence between `policy-v1.schema.json` and `validatePolicy()`, plus formal Spec Ruling preserving TEST routing (`FLASH_LOW` for simple, `FLASH_MEDIUM` for non-simple).
4. **Regression, Spec Ruling, Review, Closure (Task 4)**: Self-host isolation, full 9-suite regression pass, zero turn/call economy overhead, Two-Key review consensus, documentation cleanup, and final closure artifact.

---

## Task Breakdown

### Task 1 — Independent Baseline & Action-Leakage Removal
- [ ] **Action Leakage Audit & Elimination**:
  - Invariant: The candidate action MUST NEVER participate in the features used to decide that same action.
  - Remove any derivation of complexity, task action, domain, criticality, retry semantics, or post-investigation state from: `Subagent.TypeName`, `Subagent.Model`, `Subagent.Role`, requested profile, or policy result.
  - Decision state must be derived exclusively from: active runtime state, factual task classification, Scope Contract, retry state, evidence state, and deterministic task facts.
  - When complexity is not explicitly provided, use production router default/normalization semantics. Never use requested worker as fallback.
- [ ] **Authoritative Pure Static Baseline Helper**:
  - Implement `deriveValidatedStaticBaseline({ decisionType, facts, state })` in the routing layer / action-space.
  - For `WORKER_TIER`: `facts -> decideRoute(facts) -> classifyBaselineDecision(facts, route)`.
  - For `RETRY_ACTION` and `INVESTIGATION_STRATEGY`: extract static semantics executed today into this single production-authoritative pure helper.
  - Ensure online runtime hook (`pre-tool-enforce.mjs`), parity tests (`dream.test.mjs`), and fallback logic all consume the SAME function.
  - `STATIC_ROUTING_FALLBACK` must be derived from `deriveValidatedStaticBaseline`, never from requested profile.
- [ ] **RED Tests**:
  - **Action Leakage Test**: Same factual task state + three different requested worker profiles (`flash-low-worker`, `flash-medium-worker`, `flash-worker`) must produce the identical Decision State, identical baseline action, and identical policy action (only congruence check varies).
  - **Fallback Independence Test**: Factual task normal implementation, requested `flash-worker` (`FLASH_HIGH`), real baseline `FLASH_MEDIUM`, corrupted active policy -> `policy_source = "STATIC_ROUTING_FALLBACK"`, `baseline_action = "FLASH_MEDIUM"`, `chosen_action = "FLASH_MEDIUM"`, requested `flash-worker` MUST NOT execute.
- [ ] Verify GREEN and commit Task 1.

---

### Task 2 — Causal Decision-Point Closure & Three-Class Real Parity
- [ ] **Parity Matrix Refactoring**:
  - Remove manual `expectedRetryBaseline` maps and hardcoded `baselineAction = "IMPLEMENT_DIRECT"`.
  - Single flow across all 3 decision classes:
    `factual state -> governance available_actions -> deriveValidatedStaticBaseline -> static-policy-v1 -> compare`.
  - For every eligible state: baseline must exist, baseline must be legal according to `deriveAvailableActions`, policy must explicit-match, policy action must strictly equal baseline action.
  - Parity verification report metrics: `eligible_cases`, `baseline_resolved_cases`, `router_legal_cases`, `explicit_policy_matches`, `action_matches`, `coverage_percent = 100%`, `parity_percent = 100%`.
- [ ] **Causal Lifecycle & Pending Policy Requirement**:
  - DECISION = factual causal event actually executed.
  - Introduce deterministic ephemeral `pendingPolicyRequirement` in active runtime state:
    `{ decision_type, selected_action, policy_source, policy_id, baseline_action, policy_diagnostic }` (NOT a recorded DECISION yet).
  - **`INVESTIGATION_STRATEGY`**:
    - `IMPLEMENT_DIRECT`: record DECISION immediately before coherent mutation execution.
    - `INVESTIGATE_FIRST`: when direct implementation is attempted, block execution, establish `pendingPolicyRequirement = INVESTIGATE_FIRST`. Zero fabricated outcome or DECISION. When congruent investigation executes, validate requirement, record DECISION immediately pre-action, consume requirement, allow investigation, and mark `post_investigation = true`.
  - **`RETRY_ACTION`**:
    - `RETRY_SAME`: strictly enforced as `requestedProfile === lastWorkerProfile`. (Tests: M->M allow, M->H deny, M->L deny, L->M deny, H->M deny, H->H allow).
    - `ESCALATE_WORKER`: factual escalation defined by runtime.
    - `INVESTIGATE_FIRST`: worker retry blocked, requirement created, investigation consumes it.
    - `REPLAN`: worker retry blocked, requirement represented via existing state-machine transition. Never invent fictitious tools.
    - Retry budget never increases.
    - Denial != DECISION executed.
- [ ] **Causal Lifecycle RED Tests**:
  - Direct implementation blocked under `INVESTIGATE_FIRST` -> verify no DECISION record created, pending requirement set.
  - Congruent investigation -> verify DECISION recorded immediately pre-action, requirement consumed, `post_investigation` set.
  - Strict `RETRY_SAME` matrix tests (M->M, M->H, M->L, L->M, H->M, H->H).
- [ ] Verify GREEN and commit Task 2.

---

### Task 3 — Policy Contract Equivalence + Retry Semantics
- [ ] **Policy Contract Equivalence**:
  - Close divergence between `policy-v1.schema.json` and `validatePolicy()` in `policy-engine.mjs`:
    - Top-level policy: reject unknown properties (`additionalProperties: false`).
    - Rule: reject unknown properties (`additionalProperties: false`).
    - `when`: reject unknown properties (`additionalProperties: false`).
    - `when.post_investigation`: boolean only in v1 (reject arrays).
    - `when.attempt` & `when.retry_remaining`: non-negative integer, non-negative integer array, or `{ min, max }` object with required `min` and `max`, `min <= max`, integer >= 0, no extra properties.
    - `when.evidence`: reject unknown properties.
    - Enum arrays: non-empty, strings, must contain valid enum constants only (no arbitrary strings).
- [ ] **Differential Contract Fixture Suite**:
  - Test suite with valid and invalid fixtures proving JSON Schema draft 2020-12 and `validatePolicy()` accept and reject the exact same contract.
- [ ] **Spec Ruling — TEST Class**:
  - Preserve validated router behavior:
    - `TEST` + `SIMPLE` -> `FLASH_LOW`
    - `TEST` + non-simple (`NORMAL`, `DIFFICULT`, `EXPERIMENTAL`) -> `FLASH_MEDIUM`
  - Update `docs/superpowers/specs/2026-09-17-orchestra-dream-layer-spec.md` to document that `TEST` is an explicit state class not governed by generic "difficult/experimental implementation => FLASH_HIGH only". Legal tiers remain bounded to LOW/MEDIUM.
- [ ] **Static Policy Precision**:
  - Verify `static-policy-v1.json` preserves baseline, has 100% explicit coverage without depending on catch-all to mask unrepresented states, no rule confusing `TEST` difficult with `IMPLEMENT` difficult.
  - Recompute and verify content-addressed `policy_id`.
- [ ] Verify GREEN and commit Task 3.

---

### Task 4 — Regression, Spec Ruling, Review, Closure
- [ ] **Self-Host Isolation Regression**:
  - Add regression test asserting active runtime image resolves static policy relative to `import.meta.url` rather than repository source.
- [ ] **Documentation Cleanliness**:
  - Remove all absolute machine links (e.g. `file:///root/projects/...`) in documentation and plans; use relative repo paths.
  - Update `docs/dream-layer.md` and `runtimes/antigravity/README.md` to reflect Milestone D final state.
- [ ] **Full Regression Suite Run**:
  - `npm run test:dream`
  - `npm run test:antigravity`
  - `npm run test:hooks`
  - `npm run test:firewall`
  - `npm run test:turn-economy`
  - `npm run test:installers`
  - `npm run check:contamination`
  - `npm run doctor`
  - `git diff --check`
- [ ] **Turn Economy & Overhead Check**:
  - Confirm `model_call_delta = 0`, `model_turn_delta = 0` on normal path.
- [ ] **Two-Key Final Review**:
  - Reviewer A: Requirements, spec, and causal authority verification.
  - Reviewer B: Adversarial edge cases and security review.
  - Both Flash High, read-only: consensus `ACCEPT + ACCEPT`.
- [ ] **Final Closure Artifact & Git History**:
  - Record tracking baseline `4815c93`, initial D `a30e20a`, corrective v1 `174a4bc`, final HEAD, parity metrics, authority metrics, schema equivalence, isolation, economy, reviews, and regressions.
  - Small commits per task, no squash, no rebase. Active runtime remains Foundation A-C.
