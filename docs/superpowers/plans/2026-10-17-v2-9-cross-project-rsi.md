# V2-9 — Cross-project Dream / RSI Implementation Plan

> **For Codex execution:** Sol orchestrates; Luna implements. No investigation tasks. Learned policy may choose only inside immutable governance ceilings and must be derived from sanitized Experience records.

**Goal:** Add cross-project learning/evaluation/promotion using disjoint independent-lineage cohorts, deterministic replay, rollback, and a strict policy hierarchy.

**Architecture:** RSI reads only V2-8 Experience. It builds TRAIN/EVALUATE/HOLDOUT cohorts, evaluates bounded policy candidates, persists promotion evidence, and activates policy records below immutable governance. It does not read source code, project transcripts, or hidden reasoning.

**Base:** exact reviewed V2-8 head.

---

### Task 1: Implement independent-lineage cohort construction

**Owner:** Luna  
**Acceptance:** Sol

**Files:**
- Create: `v2/rsi/cohorts.mjs`
- Test: `tests/runtime/v2-cross-project-rsi.test.mjs`

**Hard minimum:** 4 independent Project lineages:
- TRAIN >= 2 distinct lineages;
- EVALUATE >= 1 lineage not in TRAIN;
- HOLDOUT >= 1 lineage in neither TRAIN nor EVALUATE.

**RED cases:**
- one lineage with many Experience rows is insufficient;
- duplicate Project paths/clones sharing one lineage count once;
- cohorts are disjoint by lineage ID;
- domain promotion uses only compatible sanitized domain cohorts;
- global candidate cannot be built when lineage minimum is not met;
- deterministic input order yields deterministic cohort assignment under the same seed/config;
- private Project payloads are not part of cohort objects.

Run:
```bash
node --test tests/runtime/v2-cross-project-rsi.test.mjs
```
Expected: FAIL because `v2/rsi` does not exist.

Implement a pure cohort builder over Experience query results.

Commit:
```bash
git add v2/rsi/cohorts.mjs tests/runtime/v2-cross-project-rsi.test.mjs
git commit -m "feat(v2): build independent RSI evaluation cohorts"
```

---

### Task 2: Define bounded learned-policy records and hierarchy

**Files:**
- Create: `v2/rsi/policy-store.mjs`
- Create: `v2/rsi/evaluation.mjs`
- Modify: `v2/persistence/sqlite/migrations.mjs`
- Modify: `v2/persistence/sqlite/state.mjs`
- Test: `tests/runtime/v2-cross-project-rsi.test.mjs`

Policy hierarchy is fixed:
```text
Immutable Governance
  > Global Learned Policy
  > Domain Learned Policy
  > Project Policy
  > Current Work Decision
```

**RED cases:**
- policy records contain bounded selectors/parameters only; no executable code/prompt blobs;
- global/domain policy cannot override governance-denied capability;
- project policy may narrow learned behavior but cannot widen governance;
- active policy revision is durable and auditable;
- policy candidate and active policy are distinct states;
- store corruption fails learning closed without blocking ordinary Work authority;
- learned policy activation never changes Project/Work generation by itself.

Implement SQLite persistence and a pure hierarchy resolver.

Verify:
```bash
node --test tests/runtime/v2-cross-project-rsi.test.mjs
node --test tests/runtime/v2-domain-invariants.test.mjs
```

Commit:
```bash
git add v2/rsi v2/persistence/sqlite tests/runtime/v2-cross-project-rsi.test.mjs
git commit -m "feat(v2): persist bounded learned policies"
```

---

### Task 3: Evaluate candidates across TRAIN and EVALUATE cohorts

**Files:**
- Modify: `v2/rsi/evaluation.mjs`
- Create: `v2/rsi/promotion.mjs`
- Test: `tests/runtime/v2-cross-project-rsi.test.mjs`

**RED cases:**
- candidate must have factual TRAIN support from >=2 lineages;
- candidate must meet configured outcome/metric gate on EVALUATE lineage not seen in TRAIN;
- a candidate that improves TRAIN but regresses EVALUATE is rejected;
- insufficient/corrupt Experience => no promotion;
- a Counterexample can invalidate promotion when it falls within candidate scope;
- project-specific success alone never creates GLOBAL policy;
- promotion evidence records exact Experience IDs/cohort lineages/metrics/policy revision.

Keep scoring deterministic. The initial implementation uses explicit metrics/classes already stored by V2-8; no model judgment is an acceptance signal.

Commit:
```bash
git add v2/rsi/evaluation.mjs v2/rsi/promotion.mjs tests/runtime/v2-cross-project-rsi.test.mjs
git commit -m "feat(v2): evaluate cross-project policy candidates"
```

---

### Task 4: Require HOLDOUT replay before activation

**Files:**
- Create: `v2/rsi/replay.mjs`
- Modify: `v2/rsi/promotion.mjs`
- Test: `tests/runtime/v2-rsi-replay.test.mjs`

**RED cases:**
- candidate passing TRAIN/EVALUATE but failing HOLDOUT is not activated;
- HOLDOUT lineage is absent from training/evaluation evidence;
- replay input contains only sanitized Experience;
- replay result is deterministic for fixed records/policy revision;
- missing replay facts => `RSI_REPLAY_INSUFFICIENT_EVIDENCE`, not success;
- passing replay creates auditable activation record with predecessor policy revision;
- activation remains below immutable governance.

Run:
```bash
node --test tests/runtime/v2-rsi-replay.test.mjs
```
Expected: FAIL before replay module exists.

Commit after GREEN:
```bash
git add v2/rsi/replay.mjs v2/rsi/promotion.mjs tests/runtime/v2-rsi-replay.test.mjs
git commit -m "feat(v2): gate RSI promotion on holdout replay"
```

---

### Task 5: Add rollback, demotion and counterexample response

**Files:**
- Modify: `v2/rsi/policy-store.mjs`
- Modify: `v2/rsi/promotion.mjs`
- Modify: `v2/rsi/replay.mjs`
- Test: `tests/runtime/v2-cross-project-rsi.test.mjs`
- Test: `tests/runtime/v2-rsi-replay.test.mjs`

**RED cases:**
- activated policy can be rolled back to exact predecessor revision;
- rollback is idempotent and audited;
- new qualifying Counterexample can demote policy to inactive/pending-review state;
- demotion does not delete historical evidence;
- corrupt learned policy state does not make governance permissive;
- Project execution without learned policy remains valid using baseline static policy.

Do not auto-delete or rewrite Experience during rollback.

Commit:
```bash
git add v2/rsi tests/runtime/v2-cross-project-rsi.test.mjs tests/runtime/v2-rsi-replay.test.mjs
git commit -m "feat(v2): add learned policy rollback and demotion"
```

---

### Task 6: Integrate learned policy selection into bounded decision points

**Files:**
- Create: `v2/rsi/policy-resolver.mjs`
- Modify only the v2 decision surfaces explicitly represented by learned selectors; do not touch immutable authorization functions.
- Test: `tests/runtime/v2-cross-project-rsi.test.mjs`

Initial learned selectors are limited to non-authority choices already represented by sanitized Experience, such as:
- route preference among otherwise legal routes;
- provider/profile preference among allowed choices;
- timeout/retry class within configured safe bounds;
- turn-economy strategy within accepted fidelity gates.

**RED cases:**
- learned route cannot authorize a forbidden capability;
- learned timeout cannot exceed immutable safe bounds;
- domain policy applies only to matching domain cohort;
- project policy overrides/narrows learned choice without widening governance;
- no matching policy => deterministic baseline behavior.

If a requested selector is not representable without changing governance contracts, stop with `BLOCKED_BY_SPEC_GAP` rather than widening this task.

Commit:
```bash
git add v2/rsi/policy-resolver.mjs tests/runtime/v2-cross-project-rsi.test.mjs
git commit -m "feat(v2): resolve bounded learned execution policy"
```

---

### Task 7: Close V2-9 with adversarial diversity and CI gates

**Files:**
- Modify: `.github/workflows/orchestra-v2-persistence.yml`

Add tests proving:
- 100 episodes from one lineage cannot globally promote;
- train/evaluate leakage is rejected;
- evaluate/holdout leakage is rejected;
- a hidden holdout regression blocks activation;
- corrupted Experience/policy state fails learning closed;
- governance remains unchanged with and without learned policy.

Final local verification:
```bash
node --test tests/runtime/v2-cross-project-rsi.test.mjs tests/runtime/v2-rsi-replay.test.mjs tests/runtime/v2-global-experience-store.test.mjs
node --test tests/runtime/v2-domain-invariants.test.mjs tests/runtime/v2-reference-state.test.mjs tests/runtime/v2-continuation-capsule.test.mjs
npm run test:firewall
npm run check:contamination
npm test
```

Add Ubuntu/Windows Node 24 jobs for both RSI suites, preserve all predecessor/v1 jobs, push exact head, require canonical green, update PR evidence, mark ready, no merge.
