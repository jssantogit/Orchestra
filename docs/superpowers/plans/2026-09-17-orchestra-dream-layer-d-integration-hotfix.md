# Orchestra Dream Layer Milestone D Integration Hotfix + Architecture Invariant Gate Plan

> **For agentic workers:** Execute task-by-task according to strict execution invariants:
> 1. Reproduce; 2. Trace causal flow; 3. Identify root cause; 4. Write RED test; 5. Confirm RED for expected reason; 6. Make minimal correction; 7. Confirm GREEN; 8. Run regressions; 9. Commit.

**Goal:** Execute Milestone D Integration Hotfix + Architecture Invariant Gate:
1. **Task 1 — Exact Investigation Correlation**: Enforce minimal factual identity (`conversation_id`, `parent_conversation_id`, `tool_call_id`, `step_idx`, `subagent`/profile identity, `correlation_key`). `post-tool-telemetry.mjs` only consumes `activeState.investigationInFlight` when the completion matches exact identity across all correlation dimensions. `manage_subagents` cannot close investigation without proof that the completed child is the in-flight investigator. Red counterexamples A–G normative. Preserve original decision type (`INVESTIGATION_STRATEGY` or `RETRY_ACTION`).
2. **Task 2 — Explicit Replan Execution**: Eliminate arbitrary control-plane write trigger. When `RETRY_ACTION` selects `REPLAN`: validate transition to `PLANNED` via `validateStateTransition`; immediately pre-transition, record `DECISION(REPLAN)`; transition state deterministically to `PLANNED`; deny worker retry; establish zero pending requirement waiting for generic tools. Invalid transition fails closed.
3. **Task 3 — Structural Policy Contract Closure**: Align `policy-v1.schema.json` and `validatePolicy()` for all properties (`base_policy: string | null`, `description: string`, `created_at: string`, `rule.description: string`, etc.). Add fixtures rejected by both schema and validator (`description: 42`, `base_policy: 42`, `created_at: false`, `rule.description: {}`, `policy.rules: []`, `rule.id: ""`, `post_investigation: []`, `attempt: -1`, `retry_remaining: -1`, unknown top-level, unknown rule property, unknown when property, unknown evidence property, `PLANNING` state). Preserve separate semantic-only validation.
4. **Task 4 — Architecture Invariant Gate**: Create `tests/architecture-invariants/dream-authority.test.mjs` implementing ARCH-001 through ARCH-014 with 1 valid + 1 adversarial counterexample each, calling production functions without duplicating routing/policy logic. Add package.json script `"test:architecture-invariants"` and integrate into `"test"`.
5. **Task 5 — Regressions, Parity & Closure**: Run 3-class parity matrix (280/280 cases), full regression battery, update plan and docs, create atomic commits.

---

## Task Breakdown

### Task 1 — Exact Investigation Correlation
- [x] **Define Minimal Factual Correlation Identity**:
  - In `pre-tool-enforce.mjs` (`startPendingInvestigationRequirement`): record `activeState.investigationInFlight` with:
    - `correlationKey`
    - `decision_type` (preserves `INVESTIGATION_STRATEGY` or `RETRY_ACTION`)
    - `policy_source`
    - `policy_id`
    - `toolCallId`
    - `stepIdx`
    - `conversationId`
    - `parentConversationId` (when available)
    - `subagentRole` / `subagentProfile` (e.g. `sub.Role`, `sub.TypeName`)
    - `started_at`
- [x] **Enforce Exact Correlation in PostToolUse**:
  - In `post-tool-telemetry.mjs`:
    - For `invoke_subagent`: check that incoming completion matches `conversationId`, `toolCallId`, and `correlationKey` (or execution identity) of `activeState.investigationInFlight`.
    - For `manage_subagents`: check that the completed child has factual identity matching the in-flight investigator (conversation identity, parent conversation identity, or subagent identifier). Do not close simply because `investigationInFlight` exists.
    - If matched and successful: `activeState.post_investigation = true`, clear `investigationInFlight`.
    - If matched and failed/cancelled: `activeState.post_investigation = false`, clear `investigationInFlight`.
    - If NOT matched: leave `activeState.investigationInFlight` intact, leave `post_investigation = false`.
- [x] **RED Tests (Counterexamples A through G)**:
  - A. conv-A, call-A vs conv-B, call-B -> A remains in flight, `post_investigation = false`.
  - B. Same conversation, different call -> does not close A.
  - C. Same toolCallId, incompatible conversation -> does not close A.
  - D. `manage_subagents` of unrelated child -> does not close A.
  - E. Exactly correlated completion -> closes A, `post_investigation = true`.
  - F. Exactly correlated completion + FAILED/error -> closes in flight, `post_investigation = false`.
  - G. Exactly correlated cancellation -> closes in flight, `post_investigation = false`.
  - Test preservation of original `decision_type` (`INVESTIGATION_STRATEGY` vs `RETRY_ACTION`).

### Task 2 — Explicit Replan Execution
- [x] **Remove Arbitrary Tool Replan Triggers**:
  - In `pre-tool-enforce.mjs`: remove lines 1814-1824 where any orchestrator control-plane write triggered `executeReplanTransition`.
  - Ensure NO generic tool (`write_to_file`, `run_command`, `view_file`, `replace_file_content`) triggers replan.
- [x] **Authoritative Replan Execution on RETRY_ACTION**:
  - When `RETRY_ACTION` policy evaluates to `REPLAN` during worker retry delegation:
    1. Derive governance & baseline;
    2. Confirm `selected_action === "REPLAN"`;
    3. Validate state transition `currentState -> PLANNED` via `validateStateTransition(currentState, "PLANNED", { retry: true, retry_reason })`;
    4. If invalid: fail closed (deny worker, Human Gate, do not record `DECISION(REPLAN)`, do not mutate state);
    5. If valid: immediately pre-transition, record `DECISION(REPLAN)`;
    6. Transition state deterministically: `activeState.state = "PLANNED"`;
    7. Deny worker retry with clear explanatory reason;
    8. Do NOT create `pendingPolicyRequirement` waiting for arbitrary tools.
- [x] **RED Tests**:
  - State=EXECUTING, retry_reason=MISINTERPRETED_REQUIREMENT, policy=REPLAN, worker retry attempted -> `DECISION(REPLAN)` recorded pre-transition, state transitioned to `PLANNED`, worker retry DENIED, no pending REPLAN requirement left behind.
  - Invalid state (e.g. INTAKE) attempting replan -> transition rejected, no `DECISION(REPLAN)` recorded, state unchanged, fail closed.
  - Control-plane write (`write_to_file`) no longer triggers replan transition.

### Task 3 — Structural Policy Contract Closure
- [x] **Align `policy-v1.schema.json` and `validatePolicy()`**:
  - Check `base_policy`: must be `string | null` if present.
  - Check `description`: must be `string` if present.
  - Check `created_at`: must be `string` if present.
  - Check `rule.description`: must be `string` if present.
  - Review all properties against schema.
- [x] **Fixtures Suite Expansion in `dream.test.mjs`**:
  - Add structural test cases: `description: 42`, `base_policy: 42`, `created_at: false`, `rule.description: {}`, `retry_remaining: -1`, etc.
  - Ensure both JSON Schema draft-2020-12 and `validatePolicy()` reject all invalid fixtures and accept valid ones identically.
  - Preserve semantic-only test partition.

### Task 4 — Architecture Invariant Gate
- [x] **Create `tests/architecture-invariants/dream-authority.test.mjs`**:
  - Implement ARCH-001 to ARCH-014:
    - ARCH-001: Immutable Governance Over Dream (cannot bypass state machine or safety hooks)
    - ARCH-002: Zero Online Context Overhead (no raw history in worker prompt)
    - ARCH-003: Exact Replay Epistemic Invariant (unobserved branches return UNKNOWN_BRANCH)
    - ARCH-004: Declarative Schema-Valid Policy Invariant (rejects executable code / non-schema)
    - ARCH-005: Fail-Safe Fallback to Validated Static Routing (corruption degrades to static baseline)
    - ARCH-006: Cross-Runtime Isolation (AGY only, zero Codex leakage)
    - ARCH-007: Phase 1 Record-Only Baseline Behavioral Identity (online routing remains static baseline)
    - ARCH-008: Dream Never Increases Authority or Budgets (retry budget cannot expand)
    - ARCH-009: Action-Space Governance Construction (available actions strictly governed)
    - ARCH-010: Cryptographic Content-Addressing & Integrity (policy ID hash verification)
    - ARCH-011: Independent Baseline & Action-Leakage Freedom (candidate action never leaks into baseline)
    - ARCH-012: Causal Pre-Action Decision Recording (DECISION recorded only on factual execution)
    - ARCH-013: Exact Investigation Correlation Lifecycle (completion requires matching identity)
    - ARCH-014: Authoritative REPLAN State Transition (replan executes state transition, not tool trigger)
  - Each invariant has 1 valid + 1 adversarial counterexample.
  - Calls production code from `runtimes/antigravity/`.
  - Non-zero exit on failure. Zero online context overhead.
- [x] **Update `package.json`**:
  - Add `"test:architecture-invariants": "node --test tests/architecture-invariants/dream-authority.test.mjs"`.
  - Add `npm run test:architecture-invariants` to `"test"` script.

### Task 5 — Regressions, Parity & Closure
- [x] Verify 3-class parity matrix (280/280 cases, 100% coverage, 100% parity).
- [x] Run full test battery:
  - `npm run test:dream` (69/69 passed)
  - `npm run test:antigravity` (2/2 passed)
  - `npm run test:hooks` (84/84 passed)
  - `npm run test:firewall` (4/4 passed)
  - `npm run test:turn-economy` (106/106 passed)
  - `npm run test:installers` (4/4 passed)
  - `npm run check:contamination` (PASS)
  - `npm run doctor` (HEALTHY)
  - `npm run test:architecture-invariants` (14/14 passed)
  - `npm test` (PASS)
  - `git diff --check` (CLEAN)
- [x] Update documentation (`docs/dream-layer.md`, `runtimes/antigravity/README.md`, specs).
- [x] Prepare atomic commits according to spec (orchestrator Two-Key review pending).
