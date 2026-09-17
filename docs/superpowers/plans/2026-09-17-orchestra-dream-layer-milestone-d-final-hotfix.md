# Orchestra Dream Layer Milestone D Final Hotfix Plan

> **For agentic workers:** Execute task-by-task according to strict execution invariants:
> 1. Reproduce; 2. Trace causal flow; 3. Identify root cause; 4. Write RED test; 5. Confirm RED for expected reason; 6. Make minimal correction; 7. Confirm GREEN; 8. Run regressions; 9. Commit.

**Goal:** Execute the Milestone D Final Hotfix:
1. **REPLAN State-Machine Integrity (Task 1)**: Remove `PLANNING` from all surfaces (schema, validator enum, fixtures, docs). Preserve authoritative governance state machine (`PLANNED`, never `PLANNING`). Execute factual REPLAN transition: eligible retry state -> `PLANNED` via legitimate transition logic, recording `DECISION(REPLAN)` immediately before transition and consuming `pendingPolicyRequirement`.
2. **Factual Investigation Lifecycle (Task 2)**: Fix root cause where generic operations (`view_file`, `grep_search`, `find_by_name`, `git status`) consumed `INVESTIGATE_FIRST`. Enforce 3 distinct causal moments: Requirement (pending established, zero DECISION, `post_investigation = false`), Investigation Start (congruent investigator execution, records `DECISION(INVESTIGATE_FIRST)`, converts to `investigationInFlight`, `post_investigation = false`), and Investigation Completion (correlated completion, `post_investigation = true`, in-flight removed; fails/cancels preserve `post_investigation = false`). Support both `INVESTIGATION_STRATEGY` and `RETRY_ACTION`.
3. **Policy Contract Truthfulness + Closure (Task 3)**: Represent two explicit layers: Structural Schema (`policy-v1.schema.json`, Draft 2020-12) and Normative Semantic Validator (`validatePolicy()`). Align representable structural gaps (`minItems: 1` on `rules`, `minLength: 1` on `rule.id`, `additionalProperties: false`, boolean `post_investigation`, authoritative state enum). Retitle and partition differential test suite into structural vs semantic-only fixtures. Run full 9-suite regression pass, Two-Key review, and push to `origin/main`.

---

## Task Breakdown

### Task 1 — REPLAN State-Machine Integrity
- [ ] **Remove `PLANNING` from All Surfaces**:
  - Remove `"PLANNING"` from `VALID_ENUMS.state` in `runtimes/antigravity/.agents/dream/policy-engine.mjs`.
  - Remove `"PLANNING"` from `state` enum in `runtimes/antigravity/.agents/dream/schemas/policy-v1.schema.json`.
  - Remove `activeState.state = "PLANNING"` from `pre-tool-enforce.mjs`.
  - Ensure any policy specifying `state: ["PLANNING"]` is rejected by both `policy-v1.schema.json` and `validatePolicy()`.
- [ ] **Authoritative REPLAN Transition**:
  - Implement and export `executeReplanTransition({ activeState, statePath, repoRoot, payload, toolCall, activeRole, activeContract })`.
  - Validates current state transition to `PLANNED` using authoritative state machine helper `validateStateTransition(currentState, "PLANNED")`.
  - Eligible retry states (`EXECUTING`, `DELEGATED`, `ACCEPTANCE`, `CRITICAL_REVIEW`, `BLOCKED`, `HUMAN_GATE`) legally transition to `PLANNED`.
  - Immediately before transition, records `DECISION(REPLAN)` into dream telemetry.
  - Executes transition: `activeState.state = "PLANNED"`.
  - Consumes `activeState.pendingPolicyRequirement`.
  - Zero state produced can ever be `PLANNING`.
- [ ] **RED Tests**:
  - Worker retry denied when retry policy selects `REPLAN`, establishing `pendingPolicyRequirement(REPLAN)` without changing state to `PLANNING` and without premature `DECISION`.
  - Factual replan execution records `DECISION(REPLAN)`, transitions state to `PLANNED`, and consumes pending requirement.
  - Zero state produced is `PLANNING`.
  - Schema and validator reject `state: ["PLANNING"]`.
- [ ] Confirm GREEN and commit Task 1.

---

### Task 2 — Factual Investigation Lifecycle
- [ ] **Root Cause Elimination**:
  - Remove `satisfyPendingInvestigationRequirement` from generic tool paths:
    - `allowCommand` (e.g. `git status`, shell commands);
    - inspection locks (`view_file`, `grep_search`, `find_by_name`).
- [ ] **Three-Moment Lifecycle Implementation**:
  - **Moment 1 (REQUIREMENT)**: When policy selects `INVESTIGATE_FIRST` on clean implementation or retry:
    - Worker retry / implementation denied.
    - Deterministic `pendingPolicyRequirement` established with `decision_type` preserved (`INVESTIGATION_STRATEGY` or `RETRY_ACTION`).
    - Zero `DECISION` recorded.
    - `post_investigation` remains `false`.
  - **Moment 2 (INVESTIGATION START)**: When congruent investigation starts (`sub.Role === "investigator"` or task action `INVESTIGATE`):
    - Validate pending requirement.
    - Record factual `DECISION(INVESTIGATE_FIRST)` immediately before execution, preserving original `decision_type`.
    - Convert `pendingPolicyRequirement` to `activeState.investigationInFlight`.
    - `post_investigation` remains `false`.
    - Allow execution.
  - **Moment 3 (INVESTIGATION COMPLETION)**: When correlated completion arrives:
    - If investigation succeeds: set `post_investigation = true`, remove `investigationInFlight`.
    - If investigation fails/cancels: `post_investigation` MUST remain `false`, remove `investigationInFlight`.
  - If implementation worker is attempted while pending or in-flight: DENY execution.
- [ ] **RED Tests**:
  - `pendingPolicyRequirement` + orchestrator `git status` -> pending remains, `post_investigation = false`, no `DECISION`.
  - `pendingPolicyRequirement` + orchestrator `view_file` -> pending remains.
  - `pendingPolicyRequirement` + orchestrator `grep_search` -> pending remains.
  - `pendingPolicyRequirement` + implementation worker -> DENY.
  - Full simulation: pending -> investigator starts -> `DECISION` recorded -> in flight (`post_investigation = false`) -> completion -> `post_investigation = true` -> implementation worker allowed.
  - Investigation failure/cancel -> `post_investigation` remains `false`.
  - Both `INVESTIGATION_STRATEGY` and `RETRY_ACTION` origins preserved.
- [ ] Confirm GREEN and commit Task 2.

---

### Task 3 — Policy Contract Truthfulness + Closure
- [ ] **Structural Schema vs Normative Semantic Validator Alignment**:
  - Update `runtimes/antigravity/.agents/dream/schemas/policy-v1.schema.json`:
    - `rules`: add `"minItems": 1`, `"maxItems": 128`.
    - `rule.id`: add `"minLength": 1`.
    - `rule.when.state`: remove `"PLANNING"`.
  - Document the two explicit layers:
    1. Structural Schema (`policy-v1.schema.json`): Constraints expressible in standard Draft 2020-12.
    2. Normative Semantic Validator (`validatePolicy()`): Structural constraints + relational/semantic invariants (`min <= max`, unique rule IDs, content-addressed `policy_id`, <=64 KiB canonical size).
- [ ] **Differential Test Suite**:
  - Rename to "Policy structural contract parity and semantic invariants".
  - Partition fixtures:
    - Structural fixtures: JSON Schema and validator strictly agree.
    - Semantic-only fixtures: JSON Schema may accept, validator MUST reject.
- [ ] **Documentation**:
  - Update `docs/superpowers/specs/2026-09-17-orchestra-dream-layer-spec.md`, `docs/dream-layer.md`, and `runtimes/antigravity/README.md`.
  - Ensure zero `file:///root/` URIs.
- [ ] Confirm GREEN and commit Task 3.

---

### Task 4 — Regressions, Parity, Two-Key Review & Final Push
- [ ] Run full 9-suite regression check:
  - `npm run test:dream`
  - `npm run test:antigravity`
  - `npm run test:hooks`
  - `npm run test:firewall`
  - `npm run test:turn-economy`
  - `npm run test:installers`
  - `npm run check:contamination`
  - `npm run doctor`
  - `git diff --check`
- [ ] Verify 100% coverage and 100% parity across all eligible states.
- [ ] Two-Key Final Review (Reviewer A & Reviewer B, Flash High, read-only, ACCEPT + ACCEPT).
- [ ] Push to `origin/main`.
- [ ] Final self-host report.
