# V2-5 — Codex Global Adapter Implementation Plan

> **For Codex execution:** Sol orchestrates; Luna implements. No investigation tasks. Follow `docs/superpowers/specs/2026-10-17-v2-codex-global-adapter-design.md`. If repository facts contradict it, return `BLOCKED_BY_SPEC_GAP`.

**Goal:** Connect Codex Desktop to global v2 authority/state through a thin local shim, factual ActorProvenance, Session Observation, neutral provider-event Operations, and exact tool-call correlation.

**Architecture:** Provider code translates Codex facts; `WorkAuthority` decides legality; generic provider-event liveness owns host-execution liveness; SQLite stores provider observations/correlations under Orchestra Home. No Work Lease or session ownership is recreated.

**Tech Stack:** Node.js 24, ESM, `node:test`, `node:sqlite`, existing v2 authority/liveness/reconciliation/global CLI.

**Base:** `feat/v2-reconciler-recovery` at reviewed head `a3002edb1493cc86e8e9f713477db3add31d1799`.

---

### Task 1: Persist provider Session Observations and tool correlations

**Owner:** Luna  
**Acceptance:** Sol

**Files:**
- Create: `v2/providers/session-observation-store.mjs`
- Create: `v2/providers/operation-correlation-store.mjs`
- Modify: `v2/persistence/sqlite/migrations.mjs`
- Modify: `v2/persistence/sqlite/state.mjs`
- Test: `tests/runtime/v2-codex-global-adapter.test.mjs`

**Step 1 — RED:** Add tests proving:
- observation key is `provider + projectId + actorIdHash`;
- fields are `observedInstructionEpoch`, nullable `observedWorkId`, nullable `observedGeneration`, `observedAt`;
- observation cannot reference another project's work;
- correlation key is `provider + projectId + correlationHash`;
- correlation binds exactly one `operationId/workId/generation/actorIdHash`;
- repeated identical writes are idempotent; conflicting writes fail closed;
- restart preserves records.

Run:
```bash
node --test tests/runtime/v2-codex-global-adapter.test.mjs
```
Expected: FAIL because provider stores/tables do not exist.

**Step 2 — GREEN:** Add the smallest SQLite schema migration and store APIs. Do not persist raw provider payloads or raw session/tool IDs. Hashing of provider IDs happens before store insertion.

**Step 3 — verify:**
```bash
node --test tests/runtime/v2-codex-global-adapter.test.mjs
node --test tests/runtime/v2-reference-state.test.mjs
```
Expected: PASS.

**Step 4 — commit:**
```bash
git add v2/providers v2/persistence/sqlite tests/runtime/v2-codex-global-adapter.test.mjs
git commit -m "feat(v2): persist provider observations and correlations"
```

---

### Task 2: Add neutral provider-event liveness

**Files:**
- Create: `v2/liveness/provider-event-liveness.mjs`
- Modify: `v2/liveness/contracts.mjs`
- Modify: `v2/liveness/operation-liveness-service.mjs`
- Test: `tests/runtime/v2-provider-event-liveness.test.mjs`

**RED cases:**
- provider-event owner is not a local PID owner;
- current positive provider event + unexpired deadline can prove LIVE only under the explicit provider-event freshness rule;
- expired deadline + stale event + no contradictory fresh fact => `STALE_RECOVERABLE`;
- missing/contradictory/future-skew/reordered facts => `UNKNOWN`;
- factual terminal Operation remains `TERMINAL`;
- no timeout path reports success.

Run:
```bash
node --test tests/runtime/v2-provider-event-liveness.test.mjs
```
Expected: FAIL because provider-event owner class is unsupported.

**GREEN implementation:** define provider-neutral facts only (`ownerKind=PROVIDER_EVENT`, correlation ref, event timestamps, deadline). Extend `createOperationLivenessService` by owner kind without importing Codex code. Keep existing local-process behavior unchanged.

Verify:
```bash
node --test tests/runtime/v2-provider-event-liveness.test.mjs
node --test tests/runtime/v2-domain-invariants.test.mjs
```

Commit:
```bash
git add v2/liveness tests/runtime/v2-provider-event-liveness.test.mjs
git commit -m "feat(v2): add provider event operation liveness"
```

---

### Task 3: Implement Codex factual normalization and SessionStart attach

**Files:**
- Create: `v2/providers/codex/actor.mjs`
- Create: `v2/providers/codex/tool-event.mjs`
- Create: `v2/providers/codex/hook-handler.mjs`
- Modify: `v2/global/cli.mjs`
- Test: `tests/runtime/v2-codex-global-adapter.test.mjs`

Use the existing v1 adapter files only as factual format references:
- `providers/codex/adapter/session.mjs`
- `providers/codex/adapter/tool-event.mjs`

Do not import v1 authority/runtime code.

**RED cases:**
- factual `session_id` hashes into root ActorProvenance;
- factual `agent_id` produces child provenance with hashed parent;
- missing identity => `CODEX_PROVIDER_IDENTITY_INVALID`;
- environment identity never substitutes missing payload identity;
- SessionStart resolves Project through global registry;
- active Work => `WorkAuthority.attach` result persisted as Session Observation;
- no active Work => successful `ORCHESTRA_V2_INTAKE` with null work/generation;
- unregistered workspace => `PROJECT_NOT_REGISTERED` and no implicit registration;
- second fresh session attaches to same Work without ownership transfer.

Run the single test file and prove RED, then implement minimal handler and CLI route `provider codex hook`.

Verify:
```bash
node --test tests/runtime/v2-codex-global-adapter.test.mjs
node --test tests/runtime/v2-sessionless-work.test.mjs 2>/dev/null || true
node --test tests/runtime/v2-domain-invariants.test.mjs
```
If the named historical suite does not exist, omit only that command; do not create substitute architecture.

Commit:
```bash
git add v2/providers/codex v2/global/cli.mjs tests/runtime/v2-codex-global-adapter.test.mjs
git commit -m "feat(v2): attach Codex sessions to global work authority"
```

---

### Task 4: Authorize PreToolUse and begin exact mutation Operations

**Files:**
- Modify: `v2/providers/codex/hook-handler.mjs`
- Modify: `v2/providers/codex/tool-event.mjs`
- Modify: `v2/providers/operation-correlation-store.mjs`
- Test: `tests/runtime/v2-codex-global-adapter.test.mjs`

**RED cases:**
- protected action without Session Observation => `CODEX_SESSION_OBSERVATION_MISSING`;
- epoch drift => `SESSION_RUNTIME_STALE` on PreToolUse;
- stale work ID => `STALE_ACTIVE_WORK` even with same numeric generation;
- stale generation => `STALE_GENERATION`;
- proven read-only action authorizes without mutation Operation;
- unknown/side-effecting command takes mutation path;
- mutation without `tool_call_id` => `CODEX_TOOL_CORRELATION_REQUIRED`;
- mutation with correlation begins one global Operation and one correlation record;
- hook PID is never used as RuntimeOwner;
- an existing incompatible live mutation blocks the new mutation through neutral authority.

Implement by calling `WorkAuthority.authorize`; do not repeat its generation/active-work logic in the adapter. Begin Operation only after authorization succeeds.

Verify focused tests + provider-event liveness suite.

Commit:
```bash
git add v2/providers/codex v2/providers/operation-correlation-store.mjs tests/runtime/v2-codex-global-adapter.test.mjs
git commit -m "feat(v2): bind Codex mutations to global operations"
```

---

### Task 5: Terminalize exactly matching PostToolUse Operations

**Files:**
- Modify: `v2/providers/codex/hook-handler.mjs`
- Modify: `v2/providers/operation-correlation-store.mjs`
- Test: `tests/runtime/v2-codex-global-adapter.test.mjs`

**RED cases:**
- matching PostToolUse terminalizes exactly correlated Operation;
- duplicate PostToolUse converges idempotently;
- missing correlation => `CODEX_TOOL_OPERATION_NOT_FOUND`;
- multiple contradictory records => `CODEX_TOOL_OPERATION_AMBIGUOUS`;
- actor/project/work/generation mismatch => `CODEX_PROVIDER_EVENT_MISMATCH`;
- mismatched PostToolUse cannot terminalize another writer;
- missing terminal event leaves Operation non-successful and recoverable only through provider-event liveness/Reconciler.

No generic `release current writer` API is permitted.

Verify:
```bash
node --test tests/runtime/v2-codex-global-adapter.test.mjs tests/runtime/v2-provider-event-liveness.test.mjs
```

Commit:
```bash
git add v2/providers tests/runtime/v2-codex-global-adapter.test.mjs
git commit -m "feat(v2): terminalize correlated Codex tool operations"
```

---

### Task 6: Add the thin Codex project shim and additive installer

**Files:**
- Create: `v2/providers/codex/shim-template.mjs`
- Create: `v2/providers/codex/shim-manager.mjs`
- Modify: `v2/global/cli.mjs`
- Test: `tests/runtime/v2-codex-global-adapter.test.mjs`
- Modify only if required by the existing installer contract: `tests/installers/codex-project-runtime-manager.test.mjs`

**RED cases:**
- generated local surface contains only hook config + thin transport shim;
- shim forwards stdin to the stable global launcher and returns its stdout;
- malformed/global-unavailable response fails closed as `ORCHESTRA_V2_GLOBAL_UNAVAILABLE`;
- v2 shim does not contain/import Work Lease, Reconciler, policy, or copied global core;
- installing v2 shim does not delete v1 files;
- unmigrated v1 project remains unchanged;
- Windows command path and POSIX command path are both represented safely.

The shim may resolve its own transport path but may not execute a mutable project-local governance runtime.

Verify:
```bash
node --test tests/runtime/v2-codex-global-adapter.test.mjs
npm run test:installers
npm run test:firewall
npm run check:runtimes
npm run check:runtime-core
```

Commit:
```bash
git add v2/providers/codex v2/global/cli.mjs tests/runtime tests/installers
git commit -m "feat(v2): add thin Codex global control plane shim"
```

---

### Task 7: Close V2-5 with portability and compatibility evidence

**Files:**
- Modify: `.github/workflows/orchestra-v2-persistence.yml`
- Update: PR body only after exact-head CI

Add explicit Node 24 Ubuntu/Windows execution of:
```bash
node --test tests/runtime/v2-codex-global-adapter.test.mjs tests/runtime/v2-provider-event-liveness.test.mjs
```
Do not remove existing jobs.

Run locally:
```bash
node --test tests/runtime/v2-codex-global-adapter.test.mjs tests/runtime/v2-provider-event-liveness.test.mjs
node --test tests/runtime/v2-domain-invariants.test.mjs tests/runtime/v2-reference-state.test.mjs tests/runtime/v2-continuation-capsule.test.mjs
npm run test:firewall
npm run test:installers
npm run check:runtimes
npm run check:runtime-core
npm test
```

Commit workflow changes, push exact head, and require canonical CI green on Ubuntu, Windows, and v1 compatibility. Sol records the run/head and marks the stacked PR ready for review. No merge.
