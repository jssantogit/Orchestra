# Orchestra 1.x Core Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the canonical provider-neutral schemas, domain contracts, runtime-core bridge, and regression oracle required by Orchestra 1.x without changing the externally observable 0.10 workflow.

**Architecture:** Introduce `core/` and `schemas/` as canonical development source, then mirror only the provider-neutral runtime subset into each provider runtime as a temporary generated bridge so existing project installers remain self-contained. Extract only modules already byte-identical across Codex and Antigravity first; provider-local behavior remains authoritative until later plans switch it deliberately.

**Tech Stack:** Node.js ESM, `node:test`, JSON Schema draft 2020-12, Ajv 8, existing npm scripts and provider runtime managers.

**Spec:** `docs/superpowers/specs/2026-10-08-orchestra-1x-direct-work-architecture.md`

## Global Constraints

- Preserve all existing 0.10 behavior while this plan lands; current tests are the regression oracle.
- A model is not authority; failed/missing execution is not evidence; acceptance remains control-plane authority.
- Core imports no Codex or Antigravity runtime code.
- Codex and Antigravity must never import one another.
- Provider transcripts, prompts, hidden reasoning, secrets, raw stdout/stderr, and environment dumps are never canonical domain state.
- Generated provider-local core mirrors are transitional build artifacts and must never become hand-edited source.
- No existing session-authority or handoff behavior is removed in this plan.

## Review Focus

- Unknown or provider-specific schema fields must fail closed instead of being silently accepted — pinned by `tests/core/schema-validation.test.mjs`.
- A stale/generated provider runtime core mirror must be detected before CI/Doctor can pass — pinned by `tests/core/runtime-core-sync.test.mjs`.
- A provider runtime missing its generated core payload must fail with an explicit health error rather than a module-not-found surprise — pinned by installer/Doctor tests.
- Extracted evidence/watch/feedback behavior must remain byte/behavior equivalent across providers — pinned by `tests/core/core-extraction-parity.test.mjs`.
- Provider model IDs, hook field names, or session semantics must not leak into `core/` or `schemas/` — pinned by `tests/cross-runtime/core-provider-firewall.test.mjs`.

---

### Task 1: Add canonical schema validation infrastructure

**Files:**
- Create: `core/schema/validator.mjs`
- Create: `schemas/implementation-packet.v1.schema.json`
- Create: `schemas/scope-contract.v2.schema.json`
- Create: `schemas/candidate.v1.schema.json`
- Create: `schemas/evidence.v1.schema.json`
- Create: `schemas/audit-result.v1.schema.json`
- Create: `schemas/work-lease.v1.schema.json`
- Create: `schemas/runtime-event.v1.schema.json`
- Create: `tests/core/schema-validation.test.mjs`
- Modify: `package.json`
- Create: `package-lock.json`

**Interfaces:**
- Produces: `validateSchema(schemaFile: string, value: unknown) -> { valid: boolean, errors: Array<{ path: string, keyword: string, message: string }> }`
- Produces: `assertSchema(schemaFile: string, value: unknown) -> unknown`, throwing `ORCHESTRA_SCHEMA_INVALID:<schemaFile>` with compact errors.

- [ ] **Step 1: Write failing schema tests**
  - `implementation-packet.v1` accepts the spec example and rejects missing `taskId`, invalid discovery modes, unknown top-level properties, and unauthorized free-form transcript/reasoning fields.
  - `work-lease.v1` requires non-negative integer `generation`, explicit `workspaceId`, `taskId`, state, actor provenance, and capabilities.
  - Every schema rejects unknown top-level properties unless the spec explicitly permits an extension object.

- [ ] **Step 2: Run the focused test and confirm RED**
  - Run: `node --test tests/core/schema-validation.test.mjs`
  - Expected: FAIL because validator/schemas do not exist.

- [ ] **Step 3: Add Ajv 8 and implement the minimal validator**
  - Add `ajv` as a production dependency and lock it.
  - `validator.mjs` loads schemas only from repository `schemas/`, uses draft 2020-12 validation, caches compiled schemas, and returns deterministic compact errors.

- [ ] **Step 4: Add the seven schemas with exact v1/v2 schema IDs from the spec**
  - Required enum values include discovery `NONE|DIRECTED|INVESTIGATIVE` and audit verdict `PASS|BLOCKING_FINDING`.
  - `scope-contract.v2` makes `requiredEvidence`, `sideEffectCapabilities`, and `stopConditions` first-class; do not resurrect stale `requiredValidation` as canonical state.

- [ ] **Step 5: Verify GREEN**
  - Run: `node --test tests/core/schema-validation.test.mjs`
  - Expected: PASS.

- [ ] **Step 6: Commit**
  - Commit message: `feat(core): add canonical Orchestra schemas`

---

### Task 2: Add focused domain contract modules

**Files:**
- Create: `core/domain/implementation-packet.mjs`
- Create: `core/domain/scope-contract.mjs`
- Create: `core/domain/candidate.mjs`
- Create: `core/domain/evidence.mjs`
- Create: `core/domain/audit-result.mjs`
- Create: `core/domain/work-lease.mjs`
- Create: `core/domain/runtime-event.mjs`
- Create: `tests/core/domain-contracts.test.mjs`

**Interfaces:**
- Produces: `DISCOVERY_MODES = { NONE, DIRECTED, INVESTIGATIVE }`.
- Produces: `validateImplementationPacket(packet)`, `validateScopeContract(contract)`, `validateCandidate(candidate)`, `validateEvidence(record)`, `validateAuditResult(result)`, `validateWorkLease(lease)`, and `validateRuntimeEvent(event)`; each returns the compact `validateSchema` result.
- Produces: `assert*` counterpart for every validator; no domain module imports provider code.

- [ ] **Step 1: Write failing contract tests**
  - Assert the domain constants exactly match schema enums.
  - Assert provider-specific fields such as `session_id`, `conversationId`, `gpt-6-sol`, or Gemini model IDs are not required domain fields.
  - Assert raw session identity may appear only inside bounded provenance/actor objects permitted by the schema.

- [ ] **Step 2: Confirm RED**
  - Run: `node --test tests/core/domain-contracts.test.mjs`
  - Expected: FAIL because domain modules do not exist.

- [ ] **Step 3: Implement thin schema-backed domain modules**
  - Keep modules focused: constants + normalization limited to domain spelling + schema validation. No routing logic yet.

- [ ] **Step 4: Verify GREEN**
  - Run: `node --test tests/core/domain-contracts.test.mjs tests/core/schema-validation.test.mjs`
  - Expected: PASS.

- [ ] **Step 5: Commit**
  - Commit message: `feat(core): add provider-neutral domain contracts`

---

### Task 3: Add a temporary generated runtime-core bridge

**Files:**
- Create: `scripts/sync-runtime-core.mjs`
- Create: `scripts/check-runtime-core.mjs`
- Create: `tests/core/runtime-core-sync.test.mjs`
- Modify: `package.json`
- Modify: `scripts/doctor.sh`
- Generated by sync: `runtimes/codex/.codex/astra-orchestra/core/**`
- Generated by sync: `runtimes/antigravity/.agents/skills/orchestra/core/**`
- Generated by sync: provider-local `core/schemas/**`

**Interfaces:**
- Produces: `syncRuntimeCore({ repoRoot, checkOnly = false }) -> { changed: string[], stale: string[], missing: string[] }`.
- CLI: `node scripts/sync-runtime-core.mjs` writes generated mirrors; `node scripts/check-runtime-core.mjs` exits non-zero on drift.

- [ ] **Step 1: Write failing sync tests**
  - Empty mirror reports missing files.
  - Modified generated file reports stale content.
  - Sync repairs drift exactly from canonical `core/` + `schemas/`.
  - Provider-specific source outside the generated mirror is never copied into core.

- [ ] **Step 2: Confirm RED**
  - Run: `node --test tests/core/runtime-core-sync.test.mjs`
  - Expected: FAIL.

- [ ] **Step 3: Implement deterministic sync/check tooling**
  - Canonical source is top-level `core/` and `schemas/` only.
  - Generated mirrors include a machine-generated header/manifest and are overwritten wholesale by sync.
  - Do not copy tests, docs, provider adapters, or labs.

- [ ] **Step 4: Wire health checks**
  - Add `check:runtime-core` npm script.
  - Doctor reports `Runtime core mirror: OK|DRIFT|MISSING` before provider syntax tests.

- [ ] **Step 5: Generate mirrors and verify GREEN**
  - Run: `node scripts/sync-runtime-core.mjs && node --test tests/core/runtime-core-sync.test.mjs && npm run check:runtime-core`
  - Expected: PASS and zero drift.

- [ ] **Step 6: Commit**
  - Commit message: `build(runtime): add generated neutral core bridge`

---

### Task 4: Extract byte-identical neutral modules into canonical core

**Files:**
- Create: `core/evidence/evidence-federation.mjs`
- Create: `core/evidence/evidence-watch.mjs`
- Create: `core/feedback/feedback-plane.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/evidence-federation.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/evidence-watch.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/feedback-plane.mjs`
- Modify: `runtimes/antigravity/.agents/skills/orchestra/evidence-federation.mjs`
- Modify: `runtimes/antigravity/.agents/skills/orchestra/evidence-watch.mjs`
- Modify: `runtimes/antigravity/.agents/skills/orchestra/feedback-plane.mjs`
- Create: `tests/core/core-extraction-parity.test.mjs`

**Interfaces:**
- Canonical core modules preserve every existing named export and behavior from the current provider-local files.
- Provider-local files become compatibility re-exports from their generated local `./core/...` payload; callers do not change import paths in this task.

- [ ] **Step 1: Write failing parity tests**
  - Assert the three Codex and Antigravity modules are currently byte-identical at baseline.
  - Assert provider compatibility modules expose the same export names and representative behavior as canonical core.

- [ ] **Step 2: Confirm RED for the new canonical import path**
  - Run: `node --test tests/core/core-extraction-parity.test.mjs`
  - Expected: FAIL because canonical modules do not exist.

- [ ] **Step 3: Move exact source into canonical core and replace provider copies with compatibility re-exports**
  - No semantic edits during extraction.
  - Re-run `scripts/sync-runtime-core.mjs` after adding canonical modules.

- [ ] **Step 4: Run evidence/feedback regressions**
  - Run: `npm run test:evidence && npm run test:feedback && node --test tests/core/core-extraction-parity.test.mjs`
  - Expected: PASS.

- [ ] **Step 5: Commit**
  - Commit message: `refactor(core): extract neutral evidence primitives`

---

### Task 5: Codify the new core firewall and workflow-economy baseline

**Files:**
- Create: `tests/cross-runtime/core-provider-firewall.test.mjs`
- Modify: `tests/cross-runtime/cross-runtime-firewall.test.mjs`
- Modify: `scripts/contamination-check.mjs`
- Modify: `tests/turn-economy/instrumentation.test.mjs`
- Modify: `benchmarks/turn-economy/turn-analysis.mjs`
- Modify: `AGENTS.md`
- Modify: `shared/principles.md`
- Modify: `package.json`

**Interfaces:**
- Core firewall rule: `core/**` may be imported by provider runtimes; `core/**` may not import `runtimes/**`, provider model IDs, provider hook APIs, or provider session field names.
- Metrics schema gains: `control_turns`, `worker_turns`, `repository_discovery_ops`, `redundant_reads`, `turns_to_first_edit`, `delegations`, `model_handoffs`, and `approximate_cost` (nullable).

- [ ] **Step 1: Write failing firewall and metric tests**
  - Inject fixture strings/imports showing provider leakage is rejected.
  - Assert old benchmark result files remain readable when new metrics are absent; new fields normalize to `null`/zero according to metric semantics.

- [ ] **Step 2: Confirm RED**
  - Run: `node --test tests/cross-runtime/core-provider-firewall.test.mjs tests/turn-economy/instrumentation.test.mjs`
  - Expected: FAIL on missing policy/fields.

- [ ] **Step 3: Update firewall/contamination semantics and architecture docs**
  - Replace the old “no executable shared behavior” rule with “core provider-neutral; adapters one-way into core; providers never import each other.”

- [ ] **Step 4: Add metric normalization without changing routing**
  - Existing benchmark fixtures must keep passing; this task only establishes measurement vocabulary.

- [ ] **Step 5: Verify focused suites**
  - Run: `npm run test:firewall && npm run test:turn-economy && npm run check:contamination`
  - Expected: PASS.

- [ ] **Step 6: Commit**
  - Commit message: `test(core): codify provider-neutral firewall and metrics`

---

### Task 6: Foundation regression gate

**Files:**
- Modify only if failures expose a real compatibility bug; no opportunistic refactors.

**Interfaces:**
- Produces the stable foundation consumed by `2026-10-08-orchestra-1x-direct-work.md`.

- [ ] **Step 1: Verify generated runtime is clean**
  - Run: `npm run check:runtime-core && git diff --check`
  - Expected: PASS.

- [ ] **Step 2: Run the complete baseline suite**
  - Run: `npm test`
  - Expected: all 0.10 behavior plus new core tests pass.

- [ ] **Step 3: Run Doctor and contamination checks**
  - Run: `npm run doctor && npm run check:contamination`
  - Expected: healthy/clean.

- [ ] **Step 4: Commit any narrowly required regression fix, then tag the implementation checkpoint in the PR description**
  - Commit message if needed: `fix(core): preserve 0.10 foundation behavior`
