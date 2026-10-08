# Orchestra 1.x Provider Adapters & Enforcement Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move provider mechanics and model catalogs behind explicit adapters, then decompose the current giant routing/enforcement files into focused owners without changing the already-proven Direct Work and Work Lease behavior.

**Architecture:** Canonical provider-specific source lives under `providers/codex/` and `providers/antigravity/`; the temporary sync bridge copies each provider's adapter payload into its current self-contained runtime location until the packaging plan replaces mirroring with manifest-driven builds. Core consumes only normalized facts/events and logical roles. Existing runtime entrypoints remain compatibility facades while internals move behind small modules.

**Tech Stack:** Node.js ESM, `node:test`, provider-neutral core from prior plans, current Codex hooks/TOML profiles and Antigravity hooks/Markdown profiles, temporary runtime sync bridge.

**Spec:** `docs/superpowers/specs/2026-10-08-orchestra-1x-direct-work-architecture.md`

**Prerequisites:** Core Foundation, Direct Work, and Work Lease plans complete and green.

## Global Constraints

- Core contains no provider model IDs, provider hook field names, or provider session semantics.
- Codex imports core/provider-Codex only; Antigravity imports core/provider-Antigravity only; providers never import one another.
- Logical roles are `CONTROL`, `IMPLEMENTER`, `INVESTIGATOR`, `QUICK_AUDITOR`, `CRITICAL_REVIEWER`, `MANUAL_ESCALATION`.
- Model generation changes must be catalog changes, not routing-policy rewrites.
- Decomposition is behavior-preserving unless a task explicitly names a previously approved 1.x behavior.
- Compatibility facade exports remain stable until all existing callers/tests migrate.
- No opportunistic cleanup inside giant files: extract one responsibility at a time under parity tests.

## Review Focus

- A model SKU must not influence core lane/authority semantics — pinned by `tests/provider-contract/model-catalog-boundary.test.mjs`.
- Unknown provider hook/tool events must normalize to a fail-closed `UNKNOWN` event rather than silently gaining capability — pinned by adapter tests.
- Compatibility facades must preserve current named exports and normalized outputs while internals move — pinned by `tests/provider-contract/runtime-facade-parity.test.mjs`.
- Provider adapter mirroring must not copy Codex source into Antigravity or vice versa — pinned by sync/firewall tests.
- A decomposed enforcement module must not bypass Work Lease/capability checks through an alternate entrypoint — pinned by provider hook tests and architecture invariants.

---

### Task 1: Introduce logical-role model catalogs

**Files:**
- Create: `core/domain/logical-role.mjs`
- Create: `providers/codex/model-catalog.mjs`
- Create: `providers/antigravity/model-catalog.mjs`
- Create: `tests/provider-contract/model-catalog.test.mjs`
- Create: `tests/provider-contract/model-catalog-boundary.test.mjs`
- Modify: `scripts/contamination-check.mjs`

**Interfaces:**
- Produces: `LOGICAL_ROLES = { CONTROL, IMPLEMENTER, INVESTIGATOR, QUICK_AUDITOR, CRITICAL_REVIEWER, MANUAL_ESCALATION }`.
- Each provider exports `resolveModelProfile(logicalRole, { intensity = 'standard', criticality = 'NORMAL' } = {}) -> { profile, model, reasoningEffort, logicalRole }`.
- Core receives/returns logical roles only; provider catalog is the sole canonical owner of concrete model/profile mapping.

- [ ] **Step 1: Write RED catalog/boundary tests**
  - Every logical role has an explicit provider mapping.
  - Codex maps current Sol/Luna/Astra profiles; Antigravity maps current Gemini/Flash profiles without changing current behavior.
  - Searching/import-scanning `core/**` finds no concrete GPT/Gemini model IDs.
  - Invalid logical role fails closed.

- [ ] **Step 2: Confirm RED**
  - Run: `node --test tests/provider-contract/model-catalog.test.mjs tests/provider-contract/model-catalog-boundary.test.mjs`

- [ ] **Step 3: Implement catalogs and core logical-role enum**
  - Keep provider SKU strings out of core constants/tests except explicit negative firewall fixtures.

- [ ] **Step 4: Verify GREEN and commit**
  - Commit message: `refactor(providers): centralize logical-role model catalogs`

---

### Task 2: Add canonical provider adapters and extend the temporary sync bridge

**Files:**
- Create: `providers/codex/adapter/session.mjs`
- Create: `providers/codex/adapter/tool-event.mjs`
- Create: `providers/codex/adapter/evidence.mjs`
- Create: `providers/antigravity/adapter/session.mjs`
- Create: `providers/antigravity/adapter/tool-event.mjs`
- Create: `providers/antigravity/adapter/evidence.mjs`
- Create: `tests/provider-contract/codex-adapter.test.mjs`
- Create: `tests/provider-contract/antigravity-adapter.test.mjs`
- Create: `tests/provider-contract/adapter-normalization.test.mjs`
- Modify: `scripts/sync-runtime-core.mjs`
- Modify: `scripts/check-runtime-core.mjs`
- Modify: `tests/core/runtime-core-sync.test.mjs`

**Interfaces:**
- Session adapter: `normalizeSessionActor(providerPayload) -> { provider, actorIdHash, actorKind, parentActorIdHash?, isRoot }`.
- Tool adapter: `normalizeToolEvent(providerPayload) -> { eventType, operation, target, sideEffectClass, factualIds, rawRef? }` where `rawRef` is a bounded provider-local reference, never raw transcript/output.
- Evidence adapter: `normalizeProviderEvidence(providerRecord) -> canonical Evidence`.
- Unknown/unsupported provider events normalize to an explicit `UNKNOWN`/denyable form.

- [ ] **Step 1: Write RED adapter tests from real provider fixture shapes**
  - Factual Codex `session_id` and Antigravity conversation identity normalize to equivalent actor semantics without using the same raw field name in core.
  - Parent/child identity remains attributable.
  - Malformed or missing factual IDs fail closed.

- [ ] **Step 2: Write RED mirror tests**
  - Provider Codex adapter source mirrors only to Codex runtime provider payload.
  - Antigravity adapter mirrors only to Antigravity runtime provider payload.
  - `check-runtime-core` detects stale provider adapter mirrors as well as core mirrors.

- [ ] **Step 3: Implement adapters and provider-specific mirroring**
  - Temporary destinations:
    - `runtimes/codex/.codex/astra-orchestra/provider/**`
    - `runtimes/antigravity/.agents/skills/orchestra/provider/**`
  - This is transitional; the packaging plan removes this source-distribution duplication.

- [ ] **Step 4: Verify GREEN**
  - Run: `node --test tests/provider-contract/codex-adapter.test.mjs tests/provider-contract/antigravity-adapter.test.mjs tests/provider-contract/adapter-normalization.test.mjs tests/core/runtime-core-sync.test.mjs && npm run check:runtime-core`

- [ ] **Step 5: Commit**
  - Commit message: `feat(providers): add normalized provider adapters`

---

### Task 3: Extract classification and escalation from routing mini-kernels

**Files:**
- Create: `core/routing/task-classification.mjs`
- Create: `core/routing/escalation.mjs`
- Create: `tests/core/task-classification.test.mjs`
- Create: `tests/core/escalation.test.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/routing-policy.mjs`
- Modify: `runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs`
- Create: `tests/provider-contract/runtime-facade-parity.test.mjs`

**Interfaces:**
- Produces: `classifyTaskFacts(input) -> { action, domain, criticality, breadth, diagnosisState }` using provider-neutral input.
- Produces: `selectEscalation({ taskFacts, directWorkAssessment }) -> DIRECT_WORK|GUIDED_WORK|ORCHESTRATED_WORK` plus factual reason.
- Provider routing-policy files retain their public exports but delegate neutral classification/escalation to core.

- [ ] **Step 1: Capture baseline parity fixtures before extraction**
  - Representative CODE/UI/DATA/INFRA/TESTING/DOCS/RESEARCH/ORCHESTRA tasks.
  - Mechanical/direct-action cases remain provider entrypoint behavior where appropriate.

- [ ] **Step 2: Write RED canonical-core tests and facade-parity tests**

- [ ] **Step 3: Extract one pure responsibility at a time**
  - First classification normalization, then escalation. Do not mix capability/lease/acceptance edits into this commit.

- [ ] **Step 4: Verify provider routing suites and parity**
  - Run: `npm run test:codex && npm run test:antigravity && node --test tests/provider-contract/runtime-facade-parity.test.mjs`

- [ ] **Step 5: Commit**
  - Commit message: `refactor(routing): extract classification and escalation core`

---

### Task 4: Extract capability and mutation authorization from tool enforcement

**Files:**
- Create: `core/policy/capability-authorization.mjs`
- Create: `core/policy/mutation-authorization.mjs`
- Create: `tests/core/capability-authorization.test.mjs`
- Create: `tests/core/mutation-authorization.test.mjs`
- Modify: `runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/session-hook.mjs`
- Modify: provider tool adapters from Task 2 as needed.

**Interfaces:**
- Produces: `authorizeCapability({ actor, lease, packet, operation, capability }) -> { allowed, reason }`.
- Produces: `authorizeMutation({ actor, lease, generation, workspace, operation }) -> { allowed, reason }`.
- Authorization composes existing Work Lease generation fencing and packet side-effect capabilities; narrative instruction cannot grant capability.

- [ ] **Step 1: Write RED authorization tests**
  - Missing capability denied.
  - Stale lease denied before provider-specific execution.
  - Read-only operation allowed only when actor/packet permits it.
  - Provider adapter cannot upgrade `UNKNOWN` event to mutation.

- [ ] **Step 2: Extract policy and leave provider hook files as normalization + policy invocation + provider response formatting**

- [ ] **Step 3: Verify hook/authority/provider tests**
  - Run: `npm run test:hooks && npm run test:codex && npm run test:architecture-invariants`

- [ ] **Step 4: Commit**
  - Commit message: `refactor(policy): extract capability and mutation authorization`

---

### Task 5: Extract candidate/evidence transitions and stop/acceptance ownership

**Files:**
- Create: `core/state-machine/candidate-transition.mjs`
- Create: `core/state-machine/evidence-transition.mjs`
- Create: `core/acceptance/stop-decision.mjs`
- Create: `tests/core/candidate-transition.test.mjs`
- Create: `tests/core/evidence-transition.test.mjs`
- Create: `tests/core/stop-decision.test.mjs`
- Modify: `runtimes/antigravity/.agents/hooks/stop-guard.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/routing-policy.mjs`
- Modify: existing evidence/acceptance callers as required.

**Interfaces:**
- `advanceCandidate(current, event) -> nextCandidate` rejects stale generations.
- `advanceEvidence(current, event) -> nextEvidenceState` preserves failed-tool-is-not-evidence.
- `evaluateStopDecision({ workflow, packet, candidate, evidence, audit, lease }) -> ACCEPT|CONTINUE|RETURN_TO_CONTROL|BLOCKED|HUMAN_GATE`.
- Provider stop/routing files format provider-specific responses only.

- [ ] **Step 1: Write RED transition/stop tests from existing invariant scenarios plus Direct Work cases**

- [ ] **Step 2: Extract transitions with no provider imports**

- [ ] **Step 3: Verify evidence, Direct Work, hook, and architecture suites**
  - Run: `npm run test:evidence && node --test tests/direct-work/*.test.mjs && npm run test:hooks && npm run test:architecture-invariants`

- [ ] **Step 4: Commit**
  - Commit message: `refactor(core): extract candidate evidence and stop decisions`

---

### Task 6: Extract telemetry/event emission and slim provider entrypoints

**Files:**
- Create: `core/events/runtime-event.mjs`
- Create: `providers/codex/adapter/telemetry.mjs`
- Create: `providers/antigravity/adapter/telemetry.mjs`
- Create: `tests/core/runtime-event.test.mjs`
- Modify: `runtimes/antigravity/.agents/hooks/post-tool-telemetry.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/session-hook.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/routing-policy.mjs`
- Modify: `runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs`

**Interfaces:**
- Core produces canonical bounded runtime events validated by `runtime-event.v1`.
- Provider telemetry adapters append provider factual references without embedding transcript/reasoning/raw dumps.
- Runtime entrypoints become composition facades: normalize → authorize/route → persist canonical transition/event → format provider response.

- [ ] **Step 1: Write RED bounded-event and facade-size/ownership tests**
  - Test responsibilities, not arbitrary line-count gates: provider facades must import dedicated owners for classification, capability, lease, candidate/evidence, acceptance, telemetry.

- [ ] **Step 2: Extract telemetry and finish facade composition**

- [ ] **Step 3: Verify provider/full focused suites**
  - Run: `npm run test:codex && npm run test:antigravity && npm run test:hooks && npm run test:firewall && npm run check:contamination`

- [ ] **Step 4: Commit**
  - Commit message: `refactor(providers): slim runtime enforcement facades`

---

### Task 7: Provider adapter/decomposition regression gate

**Files:**
- Modify only for proven compatibility defects.

**Interfaces:**
- At this checkpoint, provider-local entrypoints are facades and logical model mappings live only in provider catalogs; temporary runtime mirrors remain until the packaging plan.

- [ ] **Step 1: Verify generated core/provider mirrors are current**
  - Run: `npm run check:schemas && npm run check:runtime-core && git diff --check`

- [ ] **Step 2: Run all provider-contract and architecture suites**
  - Run: `node --test tests/provider-contract/*.test.mjs && npm run test:architecture-invariants && npm run test:firewall`

- [ ] **Step 3: Run full regression and health checks**
  - Run: `npm test && npm run doctor && npm run check:contamination`
  - Expected: PASS.

- [ ] **Step 4: Commit only narrowly required fixes**
  - Commit message if needed: `fix(providers): preserve adapter parity`
