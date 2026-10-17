# V2-8 — Global Experience Store Implementation Plan

> **For Codex execution:** Sol orchestrates; Luna implements. No investigation tasks. Experience is an allowlisted projection of factual project events; it is never a global transcript/log store.

**Goal:** Persist sanitized, auditable cross-project Experience records under Orchestra Home using exactly the five approved initial categories, with project/lineage provenance and no raw private project content.

**Architecture:** Project-private facts enter `Experience.project(...)`; the projector emits a closed schema or rejects the input. Only projected records reach the global Experience store. Query APIs expose sanitized dimensions, not original project artifacts.

**Base:** exact reviewed V2-7 head.

---

### Task 1: Close the Experience v1 contract and sanitization policy

**Owner:** Luna  
**Acceptance:** Sol

**Files:**
- Create: `v2/experience/contracts.mjs`
- Modify: `v2/experience/project.mjs`
- Test: `tests/runtime/v2-global-experience-store.test.mjs`

The accepted categories are exactly:
1. `DIAGNOSTIC`
2. `EXECUTION`
3. `PROVIDER_TOOL_FACT`
4. `PERFORMANCE`
5. `COUNTEREXAMPLE`

A sixth category must fail validation.

**RED cases:**
- valid record requires schema/version, category, source project/lineage provenance, sanitized domain cohort, originating Work/Operation refs when present, projection policy version, facts, outcome, and generalization metadata;
- raw source bytes, patch/diff contents, prompts, transcripts, secrets/tokens, hidden reasoning, and arbitrary artifact bytes are rejected;
- nested forbidden fields are rejected, not merely top-level keys;
- normalized metrics/classes/provider/OS/runtime dimensions are accepted;
- `containsRawProjectContent` can never be true in a valid persisted record;
- source Project remains internal provenance and is not copied into model-visible cross-project payloads by default.

Run:
```bash
node --test tests/runtime/v2-global-experience-store.test.mjs
```
Expected: FAIL because the closed store contract does not exist.

Implement an explicit allowlist; do not implement blacklist-only sanitization.

Commit:
```bash
git add v2/experience tests/runtime/v2-global-experience-store.test.mjs
git commit -m "feat(v2): close sanitized experience contract"
```

---

### Task 2: Add durable global Experience persistence

**Files:**
- Create: `v2/experience/store.mjs`
- Modify: `v2/persistence/sqlite/migrations.mjs`
- Modify: `v2/persistence/sqlite/state.mjs`
- Test: `tests/runtime/v2-global-experience-store.test.mjs`

**RED cases:**
- projected record persists globally and survives restart;
- record ID/digest is deterministic for idempotent replay inputs;
- same record replay converges;
- conflicting payload for same identity fails closed;
- Project A/B records remain separately attributable while sharing one global store;
- malformed/tampered record is detected on read;
- corruption in Experience tables does not weaken or block ordinary Project/Work authority reads;
- deleting/corrupting Experience cannot grant authority.

Use existing SQLite connection/migration patterns. Experience is not stored in each project workspace.

Verify:
```bash
node --test tests/runtime/v2-global-experience-store.test.mjs
node --test tests/runtime/v2-reference-state.test.mjs
```

Commit:
```bash
git add v2/experience/store.mjs v2/persistence/sqlite tests/runtime/v2-global-experience-store.test.mjs
git commit -m "feat(v2): persist global sanitized experience"
```

---

### Task 3: Add bounded Experience query surfaces

**Files:**
- Create: `v2/experience/query.mjs`
- Test: `tests/runtime/v2-global-experience-store.test.mjs`

**RED cases:**
- query by category, provider family, domain cohort, failure/recovery class, terminal outcome, and lineage diversity metadata;
- query result never exposes raw provider IDs or source-private payloads;
- project-private query may resolve internal provenance only when explicitly scoped to that Project;
- cross-project query returns only sanitized Experience shape;
- deterministic pagination/order for identical store state;
- unknown filter fails closed rather than becoming arbitrary SQL/filter execution.

Implement fixed query parameters and prepared statements; no generic expression language.

Commit:
```bash
git add v2/experience/query.mjs tests/runtime/v2-global-experience-store.test.mjs
git commit -m "feat(v2): query sanitized global experience"
```

---

### Task 4: Project factual recovery/provider/runtime outcomes into Experience

**Files:**
- Create: `v2/experience/recorders.mjs`
- Modify only at factual terminal boundaries:
  - `v2/global/reconciliation.mjs`
  - `v2/providers/codex/hook-handler.mjs`
  - `v2/providers/antigravity/hook-handler.mjs`
  - `v2/runtime-images/manager.mjs`
- Test: `tests/runtime/v2-global-experience-store.test.mjs`

Do not make core success depend on Experience writes. Experience recording is fail-closed for learning but non-authoritative for execution.

**RED cases:**
- stale-operation recovery can emit DIAGNOSTIC record with failure/recovery classes, not workspace source contents;
- provider mutation completion can emit EXECUTION/PERFORMANCE facts with abstract operation/provider/outcome metrics;
- provider capability observation emits PROVIDER_TOOL_FACT without raw session/tool payload;
- runtime rollback/failure may emit COUNTEREXAMPLE/DIAGNOSTIC facts;
- recorder failure never changes Candidate/Evidence/Work acceptance and never converts failed execution to success;
- duplicate terminal event does not create duplicate Experience.

Implement recorder calls only after the authoritative domain transition has factually completed.

Verify:
```bash
node --test tests/runtime/v2-global-experience-store.test.mjs tests/runtime/v2-codex-global-adapter.test.mjs tests/runtime/v2-antigravity-global-adapter.test.mjs tests/runtime/v2-runtime-upgrade.test.mjs
```

Commit:
```bash
git add v2/experience/recorders.mjs v2/global/reconciliation.mjs v2/providers v2/runtime-images/manager.mjs tests/runtime/v2-global-experience-store.test.mjs
git commit -m "feat(v2): record sanitized execution experience"
```

---

### Task 5: Add privacy and anti-reidentification adversarial regressions

**Files:**
- Expand: `tests/runtime/v2-global-experience-store.test.mjs`

Add fixtures containing:
- Windows absolute username paths;
- POSIX home paths;
- source snippets embedded in error strings;
- prompt-like text fields;
- raw Git diffs;
- token/secret-shaped strings;
- provider session IDs;
- filenames/business terms that are not allowlisted dimensions.

Expected: projection rejects or normalizes these before persistence. Do not store then redact at read time.

Also prove:
- Experience from one lineage alone cannot claim independent-lineage diversity;
- Project A cannot fetch Project B private provenance through the cross-project query API.

Commit:
```bash
git add tests/runtime/v2-global-experience-store.test.mjs v2/experience
git commit -m "test(v2): harden experience privacy boundary"
```

---

### Task 6: Close V2-8 with exact-head CI

**Files:**
- Modify: `.github/workflows/orchestra-v2-persistence.yml`

Add Ubuntu/Windows Node 24 execution of:
```bash
node --test tests/runtime/v2-global-experience-store.test.mjs
```

Final local verification:
```bash
node --test tests/runtime/v2-global-experience-store.test.mjs
node --test tests/runtime/v2-runtime-images.test.mjs tests/runtime/v2-runtime-upgrade.test.mjs
node --test tests/runtime/v2-provider-symmetry.test.mjs tests/runtime/v2-provider-event-liveness.test.mjs
node --test tests/runtime/v2-domain-invariants.test.mjs tests/runtime/v2-reference-state.test.mjs tests/runtime/v2-continuation-capsule.test.mjs
npm run test:firewall
npm run check:contamination
npm test
```

Push exact head, require canonical Ubuntu/Windows/v1 compatibility green, update PR evidence, ready for review, no merge.
