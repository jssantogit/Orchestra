# Orchestra 1.x Direct Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Direct Work the fast implementation lane: Sol resolves and compresses the task, one cheap implementer executes a bounded packet, CI/evidence and an independent cheap diff auditor verify in parallel, and Sol alone accepts.

**Architecture:** Build provider-neutral lane policy in `core/`, then integrate it behind an `OFF|SHADOW|ON` migration gate in Codex and Antigravity. Direct Work never gives an implementer open-ended investigation authority; the second cheap worker audits only the candidate diff against the packet.

**Tech Stack:** Node.js ESM, `node:test`, canonical schemas/core from the Foundation plan, existing Codex TOML agent profiles, Antigravity Markdown agent profiles, existing evidence/watch runtime and turn-economy benchmarks.

**Spec:** `docs/superpowers/specs/2026-10-08-orchestra-1x-direct-work-architecture.md`

**Prerequisite:** `docs/superpowers/plans/2026-10-08-orchestra-1x-core-foundation.md` complete and green.

## Global Constraints

- Direct Work is the target default for normal bounded product work; heavy orchestration is escalation, not the starting assumption.
- Expensive control resolves intent/cause/direction; cheap implementer does not reinterpret or rediscover the task.
- Implementer discovery is `NONE` or `DIRECTED`; `INVESTIGATIVE` is never implicitly granted.
- Tests may be modified only when the Implementation Packet explicitly authorizes test mutation.
- Implementer repairs only failures clearly caused by its own patch; unrelated or uncertain failures return to control.
- Quick Auditor is an independent cheap session/context and may report only `PASS` or causal `BLOCKING_FINDING`.
- Auditor never coordinates the implementer directly; Sol confirms a finding and emits a bounded Delta Packet.
- CI/evidence and Quick Audit may start concurrently after candidate creation.
- Acceptance remains factual, candidate-bound, and control-plane only.

## Review Focus

- A worker facing insufficient direction must return `PACKET_INSUFFICIENT`, not silently switch to investigation — pinned by `tests/direct-work/implementation-packet.test.mjs`.
- A directed lookup that turns into broad repository discovery must be denied — pinned by `tests/direct-work/discovery-authorization.test.mjs`.
- An unauthorized test edit or uncertain external failure must return to control — pinned by `tests/direct-work/implementer-policy.test.mjs`.
- A Quick Audit finding about unrelated repository code must be rejected even when technically true — pinned by `tests/direct-work/quick-audit.test.mjs`.
- Evidence/audit from an older candidate generation must never satisfy acceptance — pinned by `tests/direct-work/direct-work-acceptance.test.mjs`.

---

### Task 1: Add Direct Work lane selection and state vocabulary

**Files:**
- Create: `core/workflow/direct-work-policy.mjs`
- Create: `core/workflow/direct-work-state.mjs`
- Create: `tests/direct-work/direct-work-policy.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `EXECUTION_MODES = { DIRECT_WORK, GUIDED_WORK, ORCHESTRATED_WORK }`.
- Produces: `DIRECT_WORK_STATES = { INTAKE, RESOLVING, IMPLEMENTATION_READY, IMPLEMENTING, CANDIDATE_READY, EVIDENCE_PENDING, AUDIT_PENDING, ACCEPTANCE, DONE, BLOCKED, HUMAN_GATE }`.
- Produces: `selectExecutionMode(taskFacts) -> { mode, reason, auditRequired }`.
- Produces: `transitionDirectWork(state, event) -> { allowed, nextState, reason }`.

- [ ] **Step 1: Write failing routing/state tests**
  - Normal bounded code change selects `DIRECT_WORK`.
  - Mechanical/low-risk task selects Direct Work with `auditRequired=false`.
  - Explicit open-ended diagnosis selects `GUIDED_WORK`.
  - Multiple independent workstreams or critical migration selects `ORCHESTRATED_WORK`.
  - Provider/model names do not affect lane selection.

- [ ] **Step 2: Confirm RED**
  - Run: `node --test tests/direct-work/direct-work-policy.test.mjs`
  - Expected: FAIL.

- [ ] **Step 3: Implement deterministic lane/state policy**
  - Base decisions only on task breadth, unresolved diagnosis, criticality, independent workstreams, and explicit policy flags.
  - Do not serialize transient states unless later tasks attach recovery/authority value.

- [ ] **Step 4: Verify GREEN**
  - Run: `node --test tests/direct-work/direct-work-policy.test.mjs`
  - Expected: PASS.

- [ ] **Step 5: Commit**
  - Commit message: `feat(workflow): add Direct Work lane policy`

---

### Task 2: Build implementation-ready packets and Directed Discovery authorization

**Files:**
- Create: `core/workflow/implementation-packet.mjs`
- Create: `core/policy/discovery-authorization.mjs`
- Create: `tests/direct-work/implementation-packet.test.mjs`
- Create: `tests/direct-work/discovery-authorization.test.mjs`

**Interfaces:**
- Consumes: canonical `validateImplementationPacket()` and `DISCOVERY_MODES` from Foundation.
- Produces: `buildImplementationPacket({ taskId, candidateGeneration, goal, direction, anchors, scope, permissions, validation, failurePolicy }) -> packet`.
- Produces: `assessImplementationReadiness(packet) -> { ready, reason }`, with `PACKET_INSUFFICIENT` when goal/direction/scope/validation cannot support implementation without diagnosis.
- Produces: `authorizeDiscovery({ mode, operation, target, anchors, relation }) -> { allowed, reason }`.
- Discovery operations: `EXACT_SYMBOL`, `NARROW_FILE_PATTERN`, `EXACT_TEXT`, `DIRECT_REFERENCE`, `MATCHING_TEST`, `LOCAL_WINDOW`, `BROAD_SEARCH`, `GIT_HISTORY`, `ARCHITECTURE_EXPLORE`.

- [ ] **Step 1: Write RED packet tests**
  - Packet with resolved direction and anchors is ready.
  - Missing direction or a direction equivalent to “find the bug” returns `PACKET_INSUFFICIENT`.
  - The packet can name symbols/test hints without exact paths.

- [ ] **Step 2: Write RED discovery tests**
  - `DIRECTED` permits exact symbol/file/text lookup, direct-reference following, matching-test lookup, and local windows tied to anchors.
  - `DIRECTED` denies broad grep, architecture exploration, unrelated alternative-solution search, and git history unless separately authorized.
  - `NONE` denies discovery beyond declared targets/local context.

- [ ] **Step 3: Confirm RED**
  - Run: `node --test tests/direct-work/implementation-packet.test.mjs tests/direct-work/discovery-authorization.test.mjs`
  - Expected: FAIL.

- [ ] **Step 4: Implement minimal packet/readiness/discovery policy**
  - Use semantic anchor relation as primary policy; optional numeric circuit breakers may only fail closed, never grant discovery.

- [ ] **Step 5: Verify GREEN and commit**
  - Run: `node --test tests/direct-work/implementation-packet.test.mjs tests/direct-work/discovery-authorization.test.mjs`
  - Commit message: `feat(workflow): add implementation packet and directed discovery`

---

### Task 3: Enforce implementer test/failure policy and Delta Packets

**Files:**
- Create: `core/policy/test-mutation.mjs`
- Create: `core/workflow/implementation-result.mjs`
- Create: `core/workflow/delta-packet.mjs`
- Create: `schemas/delta-packet.v1.schema.json`
- Create: `tests/direct-work/implementer-policy.test.mjs`
- Create: `tests/direct-work/delta-packet.test.mjs`

**Interfaces:**
- Produces: `authorizeTestMutation({ packet, testPath, changeKind }) -> { allowed, reason }`.
- Produces: `nextImplementationAction({ failureRelation }) -> REPAIR | RETURN_TO_CONTROL`, where only `SELF_CAUSED` maps to `REPAIR`; `UNRELATED` and `UNCERTAIN` map to `RETURN_TO_CONTROL`.
- Produces: `createFailureReturn({ command, evidenceRef, boundary, candidate })`.
- Produces: `createDeltaPacket({ originalPacket, candidate, confirmedFinding, correctionArea, revalidation }) -> deltaPacket`.

- [ ] **Step 1: Write RED authorization/failure tests**
  - Test changes denied when packet says `tests: READ_ONLY`/omits mutation capability.
  - Authorized regression-test target is allowed but unrelated test rewrite is denied.
  - `UNCERTAIN` must not trigger investigation or repair.

- [ ] **Step 2: Write RED Delta Packet tests**
  - Delta retains original task lineage/direction, contains one confirmed finding/correction area, increments candidate generation, and cannot grant `INVESTIGATIVE` discovery.

- [ ] **Step 3: Confirm RED**
  - Run: `node --test tests/direct-work/implementer-policy.test.mjs tests/direct-work/delta-packet.test.mjs`

- [ ] **Step 4: Implement minimal policies and schema**

- [ ] **Step 5: Verify GREEN and commit**
  - Commit message: `feat(workflow): bound implementer repair and delta retries`

---

### Task 4: Add independent diff-scoped Quick Audit and Direct Work acceptance

**Files:**
- Create: `core/audit/quick-audit.mjs`
- Create: `core/acceptance/direct-work.mjs`
- Create: `tests/direct-work/quick-audit.test.mjs`
- Create: `tests/direct-work/direct-work-acceptance.test.mjs`

**Interfaces:**
- Produces: `evaluateQuickAuditResult({ packet, candidate, audit }) -> { valid, verdict, findings, reason }`.
- A blocking finding is valid only when `location.path` is a changed file/hunk or `packetRequirement` names an explicit acceptance/preservation criterion with direct causal evidence.
- Produces: `evaluateDirectWorkAcceptance({ packet, candidate, evidence, audit, auditRequired, currentGeneration }) -> { accepted, reason }`.

- [ ] **Step 1: Write RED Quick Audit tests**
  - PASS is valid with zero findings.
  - Blocking finding on changed code tied to explicit packet criterion is valid.
  - Finding about unrelated file/code smell/refactor is rejected as `AUDIT_SCOPE_VIOLATION`.
  - `nit`, suggestion, or arbitrary severity is rejected by schema/policy.

- [ ] **Step 2: Write RED acceptance tests**
  - Required evidence + required PASS audit + matching candidate generation accepts.
  - Stale candidate/evidence/audit generation rejects.
  - Failed tool output cannot be elevated to evidence.
  - Missing audit does not block mechanical work when `auditRequired=false`.

- [ ] **Step 3: Implement and verify**
  - Run: `node --test tests/direct-work/quick-audit.test.mjs tests/direct-work/direct-work-acceptance.test.mjs`
  - Expected: PASS.

- [ ] **Step 4: Commit**
  - Commit message: `feat(workflow): add Quick Audit and Direct Work acceptance`

---

### Task 5: Integrate Codex implementer/auditor roles behind a migration gate

**Files:**
- Create: `runtimes/codex/.codex/agents/luna-auditor.toml`
- Modify: `runtimes/codex/.codex/agents/luna-high.toml`
- Modify: `runtimes/codex/.codex/agents/luna-medium.toml`
- Modify: `runtimes/codex/.codex/astra-orchestra/routing-policy.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/context-packet.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/INSTRUCTIONS.md`
- Modify: `runtimes/codex/.codex/astra-orchestra/codex-runtime-manager.mjs`
- Modify: `runtimes/codex/tests/routing-policy.test.mjs`
- Modify: `runtimes/codex/tests/parity.test.mjs`
- Create: `runtimes/codex/tests/direct-work.test.mjs`

**Interfaces:**
- Migration gate: `ORCHESTRA_DIRECT_WORK_MODE=off|shadow|on`; absent value is `shadow` during this task.
- Codex logical mapping: `CONTROL -> Sol`, `IMPLEMENTER -> Luna`, `QUICK_AUDITOR -> independent Luna auditor profile`.
- `createCodexWorkerPacket()` must emit/attach the canonical Implementation Packet for Direct Work instead of asking Luna to reclassify the task.

- [ ] **Step 1: Write RED provider tests**
  - `off` preserves 0.10 routing exactly.
  - `shadow` computes Direct Work decision/packet but does not alter actual route.
  - `on` routes normal bounded implementation through one implementer; no investigator/reviewer is spawned by default.
  - Luna instructions explicitly forbid reinterpretation, broad investigation, unauthorized test edits, unrelated failure repair, worker spawning, and self-acceptance.
  - Luna auditor instructions expose only packet + diff + changed files + evidence refs and demand `PASS|BLOCKING_FINDING`.

- [ ] **Step 2: Confirm RED**
  - Run: `npm run test:codex`

- [ ] **Step 3: Integrate core lane policy using generated runtime-core imports**
  - Preserve current direct-action/mechanical behavior unless Direct Work policy explicitly supersedes it.
  - Do not move session authority in this task.

- [ ] **Step 4: Verify Codex suite GREEN**
  - Run: `npm run test:codex && npm run test:codex-parity`

- [ ] **Step 5: Commit**
  - Commit message: `feat(codex): add gated Direct Work lane`

---

### Task 6: Integrate Antigravity Direct Work parity

**Files:**
- Create: `runtimes/antigravity/.agents/agents/flash-quick-auditor.md`
- Modify: `runtimes/antigravity/.agents/agents/flash-worker.md`
- Modify: `runtimes/antigravity/.agents/agents/flash-medium-worker.md`
- Modify: `runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs`
- Modify: `runtimes/antigravity/.agents/skills/orchestra/SKILL.md`
- Modify: `runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs`
- Modify: `runtimes/antigravity/.agents/hooks/stop-guard.mjs`
- Modify: `runtimes/antigravity/tests/routing-policy.test.mjs`
- Modify: `runtimes/antigravity/tests/hooks.test.mjs`
- Create: `tests/direct-work/provider-contract.test.mjs`

**Interfaces:**
- Antigravity uses the same `OFF|SHADOW|ON` semantic gate and canonical packet/discovery/audit contracts.
- Provider-contract tests compare normalized Direct Work decisions, not model/profile names.

- [ ] **Step 1: Write RED cross-provider contract tests**
  - Same normalized task facts produce same execution mode, discovery mode, test mutation policy, audit requirement, and acceptance requirements across providers.

- [ ] **Step 2: Add provider-specific worker/auditor instructions and hook enforcement**

- [ ] **Step 3: Verify provider suites**
  - Run: `npm run test:antigravity && npm run test:hooks && node --test tests/direct-work/provider-contract.test.mjs`

- [ ] **Step 4: Commit**
  - Commit message: `feat(antigravity): add Direct Work provider parity`

---

### Task 7: Parallelize post-candidate verification and measure economy

**Files:**
- Create: `core/workflow/verification-fanout.mjs`
- Create: `tests/direct-work/verification-fanout.test.mjs`
- Modify: `benchmarks/turn-economy/probes.mjs`
- Modify: `benchmarks/turn-economy/turn-analysis.mjs`
- Modify: `tests/turn-economy/instrumentation.test.mjs`
- Modify: `tests/turn-economy/turn-diet.test.mjs`

**Interfaces:**
- Produces: `planVerificationFanout({ candidate, requiredEvidence, auditRequired }) -> { parallel: Array<'EVIDENCE'|'QUICK_AUDIT'>, acceptanceWaitsFor: string[] }`.
- Neither branch creates a dependency on completion of the other before it starts.

- [ ] **Step 1: Write RED fan-out/economy tests**
  - Normal product code yields `parallel=[EVIDENCE, QUICK_AUDIT]`.
  - Mechanical task may yield evidence only.
  - Metrics record control turns, worker turns, discovery ops, redundant reads, turns to first edit, delegations, model handoffs, and nullable cost.

- [ ] **Step 2: Implement fan-out policy and benchmark instrumentation**

- [ ] **Step 3: Add representative Direct Work probes**
  - bounded bug fix;
  - authorized regression-test change;
  - unrelated external test failure;
  - Quick Audit blocking finding + one Delta Packet.

- [ ] **Step 4: Verify benchmarks/tests**
  - Run: `npm run test:turn-economy && node --test tests/direct-work/verification-fanout.test.mjs`
  - Expected qualitative shape: one control resolve, one implementer execution (+ bounded self-repair), one audit when required, one final acceptance; no repeated rediscovery chain.

- [ ] **Step 5: Commit**
  - Commit message: `perf(workflow): parallelize Direct Work verification`

---

### Task 8: Promote Direct Work from shadow to default after the gate passes

**Files:**
- Modify: Codex and Antigravity gate default in their provider adapters/routing policy.
- Modify: `docs/architecture.md`
- Modify: `docs/routing.md`
- Modify: `docs/efficiency.md`
- Modify: `runtimes/codex/README.md`
- Modify: `runtimes/antigravity/README.md`

**Interfaces:**
- Absent `ORCHESTRA_DIRECT_WORK_MODE` resolves to `on` only after all preceding Direct Work/provider/benchmark tests pass.
- `off` remains an explicit rollback escape hatch through the migration window.

- [ ] **Step 1: Run the full pre-promotion suite in `shadow`**
  - Run: `npm test && npm run doctor && npm run check:contamination`
  - Expected: PASS.

- [ ] **Step 2: Switch default to `on` and rerun provider + Direct Work + turn-economy suites**

- [ ] **Step 3: Run full regression**
  - Run: `npm test && npm run doctor && npm run check:contamination && git diff --check`
  - Expected: PASS.

- [ ] **Step 4: Commit**
  - Commit message: `feat(workflow): make Direct Work the default lane`
