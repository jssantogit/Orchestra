# Orchestra 1.x Work Lease Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace project ownership by provider conversation/session ID with temporary factual Work Leases that fence incompatible mutation while keeping session identity only as provenance.

**Architecture:** Introduce a provider-neutral atomic lease store under project-owned Orchestra state, migrate Codex and Antigravity through a `session|dual|lease` authority mode, and prove that fresh chats can continue factual work whenever no incompatible writer is active. Existing handoff/session authority remains a recovery compatibility layer until lease mode is proven and promoted.

**Tech Stack:** Node.js ESM, `node:test`, filesystem atomic `wx` locks, Git workspace fingerprinting, canonical Work Lease/Candidate/Evidence contracts from prior plans, existing Codex SessionStart/UserPromptSubmit/PreToolUse and Antigravity hook surfaces.

**Spec:** `docs/superpowers/specs/2026-10-08-orchestra-1x-direct-work-architecture.md`

**Prerequisites:** Core Foundation and Direct Work plans complete and green.

## Global Constraints

- Session/conversation ID is provenance, not permanent project ownership.
- Two incompatible writers must never hold the same workspace mutation capability concurrently.
- A historical chat ID alone must never block a healthy fresh control session.
- A new session must not steal an active factual writer lease.
- Generation fencing denies every stale mutation attempt.
- CI/evidence is candidate/work-owned and survives chat changes.
- No transcript, prompt, hidden reasoning, or arbitrary prior conversation becomes continuation authority.
- Existing handoff paths remain recovery-only until lease mode is fully verified.

## Review Focus

- Crash during atomic claim must not yield two owners or an unrecoverable permanent lock — pinned by `tests/leases/work-lease-store.test.mjs`.
- Stale generation must be denied even when stale and current sessions are the same provider identity class — pinned by `tests/leases/generation-fencing.test.mjs`.
- Fresh chat during running CI but no writer must continue the same candidate/evidence instead of resetting work — pinned by `tests/leases/session-continuation.test.mjs`.
- Fresh chat while Luna actively holds `WORKSPACE_EDIT` must receive `WRITE_LEASE_ACTIVE`, not take authority — pinned by `tests/leases/session-continuation.test.mjs`.
- Raw provider identifiers must not be required in neutral persisted authority state when a stable hash is sufficient — pinned by `tests/leases/work-lease-schema.test.mjs`.

---

### Task 1: Extract provider-neutral workspace identity and atomic lock primitives

**Files:**
- Create: `core/leases/workspace-fingerprint.mjs`
- Create: `core/leases/atomic-lock.mjs`
- Create: `tests/leases/workspace-fingerprint.test.mjs`
- Create: `tests/leases/atomic-lock.test.mjs`
- Modify later compatibility caller: `runtimes/codex/.codex/astra-orchestra/session-authority.mjs`
- Modify later compatibility caller: `runtimes/antigravity/.agents/skills/orchestra/orchestrator-handoff.mjs`

**Interfaces:**
- Produces: `readWorkspaceFingerprint(repoRoot, { excludedPaths = [] } = {}) -> { available, head, indexHash, workingTreeHash, dirtyFileCount, fingerprint }`.
- Produces: `acquireAtomicLock(lockPath, { ownerIdHash, staleAfterMs }) -> { acquired, handle, reason }`.
- Produces: `releaseAtomicLock(handle)`.
- Lock recovery may reclaim only a factually dead PID or a malformed/uninitialized lock older than the bounded stale interval.

- [ ] **Step 1: Write RED tests from current handoff semantics**
  - Dirty tracked bytes, untracked product bytes, index changes, and HEAD changes alter fingerprint.
  - Orchestra governance state is excludable and does not invalidate product identity.
  - Live lock cannot be stolen; dead-owner lock can be recovered; fresh malformed lock fails closed.

- [ ] **Step 2: Confirm RED**
  - Run: `node --test tests/leases/workspace-fingerprint.test.mjs tests/leases/atomic-lock.test.mjs`

- [ ] **Step 3: Extract minimal generic implementations from existing Codex/Antigravity handoff code**
  - Preserve current security behavior; provider-specific telemetry/names remain outside core.

- [ ] **Step 4: Verify GREEN and commit**
  - Commit message: `refactor(leases): extract workspace identity and atomic lock`

---

### Task 2: Implement the canonical Work Lease store and generation fencing

**Files:**
- Create: `core/leases/work-lease-store.mjs`
- Create: `core/leases/lease-authorizer.mjs`
- Create: `tests/leases/work-lease-store.test.mjs`
- Create: `tests/leases/generation-fencing.test.mjs`

**Interfaces:**
- Storage: `.orchestra/state/work-lease.json` and `.orchestra/state/work-lease.claim.lock` are project-owned state.
- Produces: `readWorkLease(repoRoot, workspaceId = 'primary') -> { exists, valid, lease }`.
- Produces: `claimWorkLease(repoRoot, { workspaceId, taskId, actor, capabilities, expectedGeneration = null, candidate = null }) -> { claimed, lease, reason }`.
- Produces: `transitionWorkLease(repoRoot, { generation, state, actor, capabilities, candidate }) -> { changed, lease, reason }`.
- Produces: `releaseWorkLease(repoRoot, { generation, actor, terminalState })`.
- Produces: `authorizeLeaseMutation({ lease, actor, generation, capability }) -> { allowed, reason }`.
- Denial constants include `STALE_WORK_LEASE`, `WRITE_LEASE_ACTIVE`, `CAPABILITY_NOT_GRANTED`, `LEASE_IDENTITY_INVALID`.

- [ ] **Step 1: Write RED store/fencing tests**
  - First claim starts generation 0; compatible later claim increments generation atomically.
  - Actor at generation N cannot mutate after N+1 is committed.
  - Two concurrent `WORKSPACE_EDIT` claims serialize; only one succeeds.
  - Read-only/control provenance may coexist only when it does not grant incompatible mutation.
  - Stored actor contains provider + stable session ID hash, not raw transcript/context.

- [ ] **Step 2: Confirm RED**
  - Run: `node --test tests/leases/work-lease-store.test.mjs tests/leases/generation-fencing.test.mjs`

- [ ] **Step 3: Implement store/authorizer using Task 1 lock/fingerprint primitives and canonical schema validation**

- [ ] **Step 4: Verify GREEN and commit**
  - Commit message: `feat(leases): add generation-fenced Work Lease store`

---

### Task 3: Bind candidate/evidence continuity to work rather than session

**Files:**
- Create: `core/leases/work-continuation.mjs`
- Create: `tests/leases/session-continuation.test.mjs`
- Modify: `core/acceptance/direct-work.mjs`
- Modify: provider active-state compatibility adapters only as required.

**Interfaces:**
- Produces: `buildWorkContinuation({ task, lease, candidate, evidence, audit, blockers }) -> bounded capsule`.
- Produces: `validateContinuationForLease({ continuation, lease, workspaceFingerprint })`.
- Continuation includes only task/work state, candidate identity, pending evidence/audit references, lease generation, explicit blockers, and approved implementation direction when still active.

- [ ] **Step 1: Write RED continuation tests**
  - Session A starts CI for candidate SHA X; writer releases mutation; Session B claims next compatible control generation; CI for X remains valid.
  - New session sees bounded state, never provider transcript/reasoning.
  - Candidate/evidence generation mismatch is rejected.
  - Active writer returns `WRITE_LEASE_ACTIVE` and bounded status without granting writer capability.

- [ ] **Step 2: Confirm RED and implement bounded continuation**

- [ ] **Step 3: Verify acceptance continuity**
  - Run: `node --test tests/leases/session-continuation.test.mjs tests/direct-work/direct-work-acceptance.test.mjs`

- [ ] **Step 4: Commit**
  - Commit message: `feat(leases): preserve candidate evidence across sessions`

---

### Task 4: Integrate Codex in dual authority mode

**Files:**
- Modify: `runtimes/codex/.codex/astra-orchestra/session-authority.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/session-hook.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/session-handoff-cli.mjs`
- Modify: `runtimes/codex/tests/session-authority.test.mjs`
- Modify: `runtimes/codex/tests/session-hook.test.mjs`
- Create: `runtimes/codex/tests/work-lease-authority.test.mjs`

**Interfaces:**
- Migration gate: `ORCHESTRA_AUTHORITY_MODE=session|dual|lease`; absent value is `dual` during migration.
- `session`: current 0.10 behavior.
- `dual`: session record remains provenance/compatibility, but lease authorizer is evaluated for mutation and continuation; mismatches are surfaced before promotion.
- `lease`: Work Lease is primary authority; session record no longer grants/denies project ownership by itself.

- [ ] **Step 1: Write RED Codex dual-mode tests**
  - Current root keeps working in `session` mode unchanged.
  - In `dual`, a fresh root with no active writer can claim compatible work without prepared handoff.
  - Historical `main_session_id` mismatch is telemetry/provenance, not automatic denial, when lease claim is valid.
  - Active `WORKSPACE_EDIT` lease blocks a fresh root from mutation.
  - Former generation is fenced after compatible new claim.

- [ ] **Step 2: Integrate SessionStart/UserPromptSubmit/PreToolUse with lease checks**
  - Keep provider `session_id` factual; hash it before neutral persistence.
  - Keep manual handoff CLI as recovery/debug compatibility path.

- [ ] **Step 3: Verify Codex authority suites**
  - Run: `node --test runtimes/codex/tests/session-authority.test.mjs runtimes/codex/tests/session-hook.test.mjs runtimes/codex/tests/work-lease-authority.test.mjs`

- [ ] **Step 4: Commit**
  - Commit message: `feat(codex): add dual Work Lease authority`

---

### Task 5: Integrate Antigravity in dual authority mode

**Files:**
- Modify: `runtimes/antigravity/.agents/hooks/pre-invocation-guard.mjs`
- Modify: `runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs`
- Modify: `runtimes/antigravity/.agents/skills/orchestra/orchestrator-handoff.mjs`
- Modify: `runtimes/antigravity/.agents/skills/orchestra/orchestrator-handoff-cli.mjs`
- Modify: `runtimes/antigravity/tests/hooks.test.mjs`
- Modify: `tests/handoff/orchestrator-session-handoff.test.mjs`
- Create: `tests/leases/antigravity-work-lease.test.mjs`

**Interfaces:**
- Same `session|dual|lease` authority semantics as Codex, normalized through factual Antigravity conversation identity.
- `mainConversationId` remains historical/recovery compatibility state during dual mode but cannot independently block a valid lease claim.

- [ ] **Step 1: Write RED Antigravity lease tests**
  - Fresh root without active writer continues work without explicit handoff.
  - Child/reviewer/worker identity cannot claim control/write lease merely because it has a conversation ID.
  - Active writer remains protected.
  - Old conversation becomes stale for mutation after generation advancement.

- [ ] **Step 2: Integrate pre-invocation/tool enforcement with core lease authorizer**

- [ ] **Step 3: Verify AGY/handoff suites**
  - Run: `npm run test:hooks && npm run test:handoff && node --test tests/leases/antigravity-work-lease.test.mjs`

- [ ] **Step 4: Commit**
  - Commit message: `feat(antigravity): add dual Work Lease authority`

---

### Task 6: Add cross-provider lease authority invariants

**Files:**
- Create: `tests/architecture-invariants/work-lease-authority.test.mjs`
- Modify: `tests/architecture-invariants/codex-session-authority.test.mjs`
- Modify: `tests/architecture-invariants/orchestrator-handoff-authority.test.mjs`
- Modify: `tests/cross-runtime/core-provider-firewall.test.mjs`
- Modify: `package.json`

**Interfaces:**
- New permanent invariant: `session identity = provenance`, `work lease = authority`, `generation = mutation fence`.

- [ ] **Step 1: Write RED architecture invariants**
  - No provider session/conversation ID is the sole primary project-owner test in `lease` mode.
  - Provider IDs remain required for attributable actor provenance.
  - Both providers call the same neutral lease authorizer contract without importing one another.

- [ ] **Step 2: Update invariant suite and verify**
  - Run: `npm run test:architecture-invariants && npm run test:firewall`

- [ ] **Step 3: Commit**
  - Commit message: `test(authority): codify Work Lease invariants`

---

### Task 7: Promote lease authority and demote handoff to recovery

**Files:**
- Modify: provider authority-mode defaults to `lease`.
- Modify: `docs/architecture.md`
- Modify: `docs/codex.md`
- Modify: `docs/antigravity.md`
- Modify: `runtimes/codex/README.md`
- Modify: `runtimes/antigravity/README.md`
- Modify: `README.md`

**Interfaces:**
- Absent `ORCHESTRA_AUTHORITY_MODE` becomes `lease` only after all preceding tests pass.
- `session` remains temporary rollback mode; handoff CLIs remain recovery/debug tools, not normal UX.

- [ ] **Step 1: Run complete suite in `dual` and exercise representative fresh-chat scenarios**
  - Fresh chat while CI runs and no writer: allowed continuation.
  - Fresh chat while implementer writes: mutation denied with `WRITE_LEASE_ACTIVE`.
  - Stale old chat after generation advance: `STALE_WORK_LEASE`.

- [ ] **Step 2: Switch default to `lease` and rerun authority/provider/full suites**
  - Run: `npm test && npm run doctor && npm run check:contamination && git diff --check`
  - Expected: PASS.

- [ ] **Step 3: Commit**
  - Commit message: `feat(authority): make Work Leases primary project authority`
