# V2-11 — Cutover, Self-hosting and Release Implementation Plan

> **For Codex execution:** Sol orchestrates; Luna implements. No investigation tasks. V2-11 is a verification/cutover milestone, not a bucket for new architecture. Any missing subsystem capability is `BLOCKED_BY_SPEC_GAP` and returns to its owning milestone.

**Goal:** Prove Orchestra v2 is operationally complete: Orchestra self-hosts through the global control plane, two independent projects run without full local brains, both providers work in real execution, crash recovery and runtime rollback are proven, migration/RSI gates pass, and v1 project-local topology can be declared obsolete for normal operation with a documented rollback path.

**Base:** exact reviewed V2-10 head.

---

### Task 1: Encode machine-checkable cutover readiness

**Owner:** Luna  
**Acceptance:** Sol

**Files:**
- Create: `v2/cutover/readiness.mjs`
- Create: `tests/runtime/v2-cutover.test.mjs`

Readiness must require factual evidence objects for:
- global registry/persistence healthy;
- Codex global adapter verified;
- Antigravity global adapter verified;
- Runtime Image install + project pin + rollback verified;
- Reconciler stale/dirty recovery verified;
- Global Experience privacy suite verified;
- RSI train/evaluate/holdout replay verified;
- migration + Tsuzuki F7 regression verified;
- Windows and POSIX verification present;
- at least two independent registered project lineages verified;
- no full v2 governance runtime materialized in those projects;
- Orchestra self-host Project verified.

**RED cases:**
- missing evidence keeps readiness false;
- one project repeated twice does not satisfy independent projects;
- stale CI/run evidence bound to another commit does not satisfy exact-head readiness;
- failed/unknown provider field result is not success;
- readiness cannot be forced by a boolean flag;
- v1 compatibility being green does not substitute missing v2 evidence.

Run:
```bash
node --test tests/runtime/v2-cutover.test.mjs
```
Expected: FAIL before readiness module exists.

Commit:
```bash
git add v2/cutover/readiness.mjs tests/runtime/v2-cutover.test.mjs
git commit -m "feat(v2): encode cutover readiness contract"
```

---

### Task 2: Add reproducible self-host verification for the Orchestra repository

**Files:**
- Create: `v2/cutover/self-host.mjs`
- Expand: `tests/runtime/v2-cutover.test.mjs`

The test harness uses temporary clones/workspaces in CI; it must not hardcode the operator's local path.

**RED cases:**
- Orchestra repository can be registered as a v2 Project;
- a current Work Unit can be started/attached without chat ownership;
- provider thin shim configuration points to global Orchestra, not a project-local v2 core;
- a mutation Operation is generation/work/epoch fenced;
- status/recovery remain global;
- self-hosting does not recursively copy `v2/**` into `.codex`/`.agents`;
- runtime image pin is explicit.

Implement a deterministic harness that creates a temporary project copy and exercises public v2 APIs/CLI. Do not special-case the real workstation.

Commit:
```bash
git add v2/cutover/self-host.mjs tests/runtime/v2-cutover.test.mjs
git commit -m "test(v2): prove Orchestra self hosting through global control plane"
```

---

### Task 3: Add two-project isolation/cutover harness

**Files:**
- Create: `v2/cutover/multi-project.mjs`
- Expand: `tests/runtime/v2-cutover.test.mjs`

**RED cases:**
- two independent lineages register under one Orchestra Home;
- each has isolated Work/Operation/evidence/runtime pin state;
- one Project stale/dirty recovery does not block the other;
- projects may pin different Runtime Images;
- Experience may aggregate sanitized facts while raw project facts remain isolated;
- provider correlation/session observations cannot cross project boundary;
- removing one project's thin shim cannot affect the other's global state.

Commit:
```bash
git add v2/cutover/multi-project.mjs tests/runtime/v2-cutover.test.mjs
git commit -m "test(v2): prove multi project global control plane isolation"
```

---

### Task 4: Create provider field-test protocol and evidence schema

**Files:**
- Create: `v2/cutover/field-evidence.mjs`
- Create: `docs/release/v2-field-test-runbook.md`
- Expand: `tests/runtime/v2-cutover.test.mjs`

The runbook is execution, not investigation. It prescribes exact scenarios and result fields.

Required real scenarios for **Codex and Antigravity**:
1. fresh session/conversation attach to active Work;
2. no-active-work INTAKE;
3. one real mutation with Operation begin/terminalization;
4. stale epoch denial after runtime pin/epoch change;
5. simulated/lost owner or bounded timeout leading to official status/recovery path;
6. no project-local v2 governance brain after migration/cleanup.

Field evidence record must include:
- provider/version;
- project lineage hash/ID;
- runtime image ID;
- commit/head under test;
- scenario ID;
- factual command/event result;
- terminal status;
- timestamp;
- sanitized log/evidence refs;
- operator attestation only as provenance, never as substitute for tool facts.

Tests reject evidence from wrong head/runtime or missing scenario IDs.

Commit:
```bash
git add v2/cutover/field-evidence.mjs docs/release/v2-field-test-runbook.md tests/runtime/v2-cutover.test.mjs
git commit -m "docs(v2): define provider cutover field evidence"
```

---

### Task 5: Prove crash recovery, upgrade and rollback end-to-end

**Files:**
- Expand: `tests/runtime/v2-cutover.test.mjs`
- Reuse public modules only: `v2/global/reconciliation.mjs`, `v2/runtime-images/manager.mjs`, `v2/migration/*`

Add an end-to-end synthetic scenario:
1. Project on runtime image A starts mutation Operation.
2. Owner becomes factually stale/dead without clean terminalization.
3. Status reports recovery action.
4. Recovery terminalizes/preserves according to workspace facts.
5. Project upgrades to B; epoch advances.
6. old session observation gets `SESSION_RUNTIME_STALE`.
7. rollback to A or another compatible installed image succeeds explicitly.
8. Project source tree is not rewritten by runtime rollback.

Also run the Tsuzuki F7 migration fixture through migration → status → recovery/dirty-resolution path.

Commit:
```bash
git add tests/runtime/v2-cutover.test.mjs
git commit -m "test(v2): prove crash recovery and runtime rollback end to end"
```

---

### Task 6: Prove Experience/RSI replay at cutover

**Files:**
- Expand: `tests/runtime/v2-cutover.test.mjs`

Create four independent synthetic lineages producing sanitized Experience:
- two TRAIN;
- one EVALUATE;
- one HOLDOUT.

Prove:
- policy candidate can promote only after evaluation + holdout replay;
- a holdout regression prevents activation;
- no raw source/prompt data appears in policy evidence;
- active learned policy cannot widen governance;
- rollback returns exact predecessor policy.

Commit:
```bash
git add tests/runtime/v2-cutover.test.mjs
git commit -m "test(v2): prove cross project RSI cutover gates"
```

---

### Task 7: Remove normal-operation dependence on v1 local authority

**Files:**
- Create: `docs/release/v2-cutover-runbook.md`
- Create: `docs/release/v2-rollback-runbook.md`
- Modify user-facing docs that describe current installation/runtime topology.
- Expand: `tests/runtime/v2-cutover.test.mjs`
- Modify release tests only as required: `tests/release/*.test.mjs`

The cutover documentation must state:
- v2 registered projects use global engine + thin provider shims;
- legacy project-local runtime is compatibility/migration-only;
- Work Lease/session handoff is not normal v2 authority;
- recovery/upgrade commands are global;
- rollback restores supported previous v2 image/integration or explicit v1 compatibility state while preserved artifacts remain auditable.

Do **not** delete v1 source/runtime code in this task unless the approved release gate explicitly says compatibility support is no longer required. The cutover is a default-topology switch, not history erasure.

Tests must fail if v2 docs/install path silently rematerialize a full local brain.

Commit:
```bash
git add docs/release tests/runtime/v2-cutover.test.mjs tests/release
git commit -m "docs(v2): define global control plane cutover and rollback"
```

---

### Task 8: Extend canonical CI and release readiness

**Files:**
- Modify: `.github/workflows/orchestra-v2-persistence.yml`
- Modify: `.github/workflows/orchestra-release.yml`
- Modify: `tests/release/*.test.mjs` where needed for v2 readiness

Canonical PR CI must execute on exact head:
```bash
node --test tests/runtime/v2-cutover.test.mjs
node --test tests/runtime/v2-migration.test.mjs tests/runtime/v2-tsuzuki-f7-migration.test.mjs
node --test tests/runtime/v2-cross-project-rsi.test.mjs tests/runtime/v2-rsi-replay.test.mjs
node --test tests/runtime/v2-global-experience-store.test.mjs
node --test tests/runtime/v2-runtime-images.test.mjs tests/runtime/v2-runtime-upgrade.test.mjs
node --test tests/runtime/v2-codex-global-adapter.test.mjs tests/runtime/v2-antigravity-global-adapter.test.mjs tests/runtime/v2-provider-symmetry.test.mjs
```
plus existing Ubuntu/Windows/v1 compatibility suites.

Release workflow/readiness must consume cutover evidence but must not auto-release merely because CI is green.

Commit:
```bash
git add .github/workflows tests/release
git commit -m "ci(v2): enforce cutover release readiness"
```

---

### Task 9: Execute the prescribed real field tests and freeze release evidence

**Owner:** Luna executes scripted steps; Sol validates evidence. No exploratory debugging branch is allowed. A failed scenario returns the factual failure to its owning milestone/task or `BLOCKED_BY_SPEC_GAP`.

Execute `docs/release/v2-field-test-runbook.md` against:
- the Orchestra repository registered/self-hosted as v2;
- at least one second independent real Project;
- Codex Desktop;
- Antigravity;
- Windows plus the CI-backed POSIX path.

Do not commit machine-specific absolute paths, raw prompts, private source, secrets, or transcripts. Commit only sanitized field evidence artifacts if the repository's release evidence convention permits them; otherwise reference the canonical CI/run and structured release record.

Sol must reject completion until all required scenario records match the exact reviewed head/runtime image.

---

### Task 10: Final verification and operator gate

Run:
```bash
node --test tests/runtime/v2-cutover.test.mjs
npm run test:runtime
npm run test:firewall
npm run test:installers
npm run check:contamination
npm run check:runtimes
npm run check:runtime-core
npm run test:release
npm run release:readiness
npm test
```

Push exact head and require every canonical v2 Ubuntu/Windows job plus v1 compatibility to pass. Sol records:
- exact branch/head;
- workflow run IDs;
- provider field evidence IDs;
- two independent Project lineages;
- self-host result;
- migration/F7 result;
- upgrade/rollback result;
- RSI holdout result;
- open blockers = none.

Mark PR ready for final operator review. **Do not merge, tag, publish, migrate additional real projects, or declare v1 removed until the operator explicitly approves cutover/release.**
