# V2-6 — Antigravity Global Adapter Implementation Plan

> **For Codex execution:** Sol orchestrates; Luna implements. No investigation tasks. Reuse V2-5 neutral provider observation/correlation/liveness primitives. If repository facts contradict the approved program spec, return `BLOCKED_BY_SPEC_GAP`.

**Goal:** Connect Antigravity to the same global Project/Work/Operation authority model used by Codex, with provider-specific protocol translation but no AGY-owned authority machine.

**Architecture:** `orchestra provider antigravity hook` normalizes factual AGY identity/events, resolves registered Project, loads provider Session Observation, calls neutral WorkAuthority, and represents host-owned activity through the V2-5 provider-event Operation contract. Orchestra-spawned AGY child processes continue to use process RuntimeOwner semantics because Orchestra factually owns those processes.

**Base:** exact reviewed V2-5 head.

---

### Task 1: Implement AGY ActorProvenance and tool-event normalization

**Owner:** Luna  
**Acceptance:** Sol

**Files:**
- Create: `v2/providers/antigravity/actor.mjs`
- Create: `v2/providers/antigravity/tool-event.mjs`
- Test: `tests/runtime/v2-antigravity-global-adapter.test.mjs`

Use these v1 files only as protocol-format references:
- `providers/antigravity/adapter/session.mjs`
- `providers/antigravity/adapter/tool-event.mjs`

**RED cases:**
- factual AGY root identity produces hashed ActorProvenance;
- factual child identity remains distinct and preserves factual parent provenance when present;
- missing provider identity fails with `ANTIGRAVITY_PROVIDER_IDENTITY_INVALID`;
- environment inference never substitutes missing provider facts;
- read/write/command events normalize into the same neutral classes used by Codex;
- unknown side-effecting action remains `UNKNOWN`/mutation-protected rather than read-only.

Run:
```bash
node --test tests/runtime/v2-antigravity-global-adapter.test.mjs
```
Expected: FAIL because v2 AGY modules do not exist.

Implement the minimum provider normalizers without importing Codex modules or v1 authority code.

Verify RED→GREEN and commit:
```bash
git add v2/providers/antigravity tests/runtime/v2-antigravity-global-adapter.test.mjs
git commit -m "feat(v2): normalize Antigravity provider facts"
```

---

### Task 2: Implement AGY SessionStart/attach and INTAKE semantics

**Files:**
- Create: `v2/providers/antigravity/hook-handler.mjs`
- Modify: `v2/global/cli.mjs`
- Reuse: `v2/providers/session-observation-store.mjs`
- Test: `tests/runtime/v2-antigravity-global-adapter.test.mjs`

Add the exact global route:
```text
orchestra provider antigravity hook
```

**RED cases:**
- registered Project + active Work attaches through `WorkAuthority.attach`;
- fresh AGY conversation does not need handoff from an older conversation;
- second fresh conversation can observe the same Work without stealing authority;
- no active Work returns successful INTAKE and stores null work/generation;
- unregistered workspace stays unregistered;
- stale instruction epoch is represented by the same neutral `SESSION_RUNTIME_STALE` reason;
- provider record is scoped to `antigravity + project + actor` and cannot collide with Codex observation.

Implement by composing the generic provider store and neutral WorkAuthority; do not copy Codex handler logic wholesale if a provider-neutral helper already exists in V2-5—extract only a genuinely neutral helper when the test proves duplication of semantics.

Verify:
```bash
node --test tests/runtime/v2-antigravity-global-adapter.test.mjs
node --test tests/runtime/v2-codex-global-adapter.test.mjs
```

Commit:
```bash
git add v2/providers/antigravity v2/global/cli.mjs tests/runtime/v2-antigravity-global-adapter.test.mjs
git commit -m "feat(v2): attach Antigravity sessions to global work authority"
```

---

### Task 3: Authorize AGY tool mutations through global Operations

**Files:**
- Modify: `v2/providers/antigravity/hook-handler.mjs`
- Reuse: `v2/providers/operation-correlation-store.mjs`
- Reuse: `v2/liveness/provider-event-liveness.mjs`
- Test: `tests/runtime/v2-antigravity-global-adapter.test.mjs`

**RED cases:**
- protected action carries observed work ID/generation/epoch into `WorkAuthority.authorize`;
- stale work ID, stale generation and stale epoch preserve neutral reason codes;
- host-owned mutation requires factual provider correlation and begins one provider-event Operation;
- missing factual correlation fails `ANTIGRAVITY_TOOL_CORRELATION_REQUIRED`;
- AGY hook process identity is not used as owner of host-owned tool execution;
- duplicate terminal event is idempotent;
- mismatched provider/project/work/actor cannot terminalize another Operation;
- lost terminal event remains UNKNOWN or STALE_RECOVERABLE strictly through the generic provider-event liveness contract.

Verify both provider suites plus generic provider-event liveness:
```bash
node --test tests/runtime/v2-antigravity-global-adapter.test.mjs tests/runtime/v2-codex-global-adapter.test.mjs tests/runtime/v2-provider-event-liveness.test.mjs
```

Commit:
```bash
git add v2/providers/antigravity tests/runtime/v2-antigravity-global-adapter.test.mjs
git commit -m "feat(v2): bind Antigravity mutations to global operations"
```

---

### Task 4: Preserve process liveness for Orchestra-spawned AGY execution

**Files:**
- Modify: `providers/antigravity/delegation-executor.mjs` only where an adapter bridge is required by the new global invocation path
- Create or modify: `v2/providers/antigravity/process-execution.mjs`
- Reuse: `v2/liveness/runtime-owner-store.mjs`
- Reuse: `v2/liveness/local-process-probe.mjs`
- Test: `tests/runtime/v2-antigravity-global-adapter.test.mjs`

This task is not a redesign of delegation. It bridges factual Orchestra-owned child processes to v2 Operations.

**RED cases:**
- when Orchestra itself spawns the AGY process, Operation records a process RuntimeOwner with PID + start identity;
- heartbeat/deadline policy uses existing process liveness contracts;
- process death/identity mismatch cannot remain LIVE;
- host-owned hook execution still uses PROVIDER_EVENT and never a process owner;
- no second AGY-specific liveness taxonomy is introduced.

Run focused AGY v2 tests and existing delegation tests after GREEN:
```bash
node --test tests/runtime/v2-antigravity-global-adapter.test.mjs
npm run test:delegation
```

Commit:
```bash
git add v2/providers/antigravity providers/antigravity/delegation-executor.mjs tests/runtime/v2-antigravity-global-adapter.test.mjs
git commit -m "feat(v2): register factual Antigravity process owners"
```

---

### Task 5: Add thin AGY integration shim without a local brain

**Files:**
- Create: `v2/providers/antigravity/shim-template.mjs`
- Create: `v2/providers/antigravity/shim-manager.mjs`
- Test: `tests/runtime/v2-antigravity-global-adapter.test.mjs`
- Modify installer tests only to cover the new additive v2 path: `tests/installers/project-runtime-manager.test.mjs`, `tests/installers/antigravity-v2-doctor.test.mjs`

**RED cases:**
- v2 AGY project integration calls only the stable global launcher;
- no `.agents` governance/runtime copy is needed for v2 operation beyond host-required thin configuration/shim;
- shim contains no Work Lease, Dream, recovery, policy, or copied neutral core;
- global launcher failure is fail-closed/actionable;
- v1 AGY installation remains untouched for unmigrated projects;
- Windows and POSIX invocation paths are covered.

Verify:
```bash
node --test tests/runtime/v2-antigravity-global-adapter.test.mjs
npm run test:installers
npm run test:antigravity
npm run test:hooks
npm run test:firewall
npm run check:runtimes
```

Commit:
```bash
git add v2/providers/antigravity tests/runtime tests/installers
git commit -m "feat(v2): add thin Antigravity global control plane shim"
```

---

### Task 6: Add provider symmetry regressions

**Files:**
- Create: `tests/runtime/v2-provider-symmetry.test.mjs`

**RED cases must assert both adapters produce equivalent neutral outcomes for:**
- fresh attach;
- INTAKE;
- stale instruction epoch;
- stale active Work;
- stale generation;
- provider-event mutation begin/terminalize;
- cross-project denial;
- recovery-required mutation blocking.

The test must compare neutral decision shapes/reasons, not provider hook JSON formatting.

Run:
```bash
node --test tests/runtime/v2-provider-symmetry.test.mjs
```
Then make only minimal neutral refactors required to pass it; provider protocol output may remain different.

Commit:
```bash
git add tests/runtime/v2-provider-symmetry.test.mjs v2/providers v2/authority v2/liveness
git commit -m "test(v2): enforce provider neutral authority symmetry"
```

---

### Task 7: Close V2-6 with exact-head CI

**Files:**
- Modify: `.github/workflows/orchestra-v2-persistence.yml`

Add Ubuntu/Windows execution of:
```bash
node --test tests/runtime/v2-antigravity-global-adapter.test.mjs tests/runtime/v2-provider-symmetry.test.mjs
```
Preserve V2-5 and v1 jobs.

Final local verification:
```bash
node --test tests/runtime/v2-codex-global-adapter.test.mjs tests/runtime/v2-antigravity-global-adapter.test.mjs tests/runtime/v2-provider-event-liveness.test.mjs tests/runtime/v2-provider-symmetry.test.mjs
node --test tests/runtime/v2-domain-invariants.test.mjs tests/runtime/v2-reference-state.test.mjs tests/runtime/v2-continuation-capsule.test.mjs
npm run test:delegation
npm run test:firewall
npm run test:installers
npm run check:runtimes
npm run check:runtime-core
npm test
```

Push exact head, require canonical CI green on Ubuntu/Windows/v1 compatibility, update PR evidence, mark ready for review, and do not merge.
