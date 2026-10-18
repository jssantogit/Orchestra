# V2-7 — Runtime Images, Project Pinning and Upgrades Implementation Plan

> **For Codex execution:** Sol orchestrates; Luna implements. No investigation tasks. Runtime image activation must consume existing Project/Reconciler/provider contracts rather than introducing a second lifecycle authority.

**Goal:** Install immutable runtime images once under Orchestra Home, pin projects to specific images, perform lifecycle-safe upgrades/rollbacks, and make newer global recovery logic available even when the currently pinned project runtime is broken.

**Architecture:** The global engine owns image installation, integrity, compatibility, upgrade/rollback commands and recovery. A Project owns only a runtime image pin + instruction epoch. Provider shims invoke the global engine, which selects the pinned image semantics after neutral lifecycle checks.

**Base:** exact reviewed V2-6 head.

---

### Task 1: Define immutable Runtime Image contracts and content store

**Owner:** Luna  
**Acceptance:** Sol

**Files:**
- Create: `v2/runtime-images/contracts.mjs`
- Create: `v2/runtime-images/store.mjs`
- Reuse: `v2/persistence/blob-store.mjs`
- Test: `tests/runtime/v2-runtime-images.test.mjs`

**RED cases:**
- image record requires schema, content-derived `imageId`, semantic version, manifest digest/ref, engine compatibility, Codex compatibility, AGY compatibility, creation timestamp;
- same bytes/manifest converge to same immutable image;
- conflicting content for same image identity is rejected;
- corrupted blob/manifest fails integrity verification;
- installed image files cannot be mutated through the public store API;
- image storage is global, not project-local.

Run:
```bash
node --test tests/runtime/v2-runtime-images.test.mjs
```
Expected: FAIL because runtime-image modules do not exist.

Implement with the existing content-addressed blob store; do not build a second blob system.

Commit:
```bash
git add v2/runtime-images tests/runtime/v2-runtime-images.test.mjs
git commit -m "feat(v2): add immutable runtime image store"
```

---

### Task 2: Persist installed images and compatibility metadata

**Files:**
- Modify: `v2/persistence/sqlite/migrations.mjs`
- Modify: `v2/persistence/sqlite/state.mjs`
- Modify: `v2/runtime-images/store.mjs`
- Test: `tests/runtime/v2-runtime-images.test.mjs`

**RED cases:**
- install survives restart;
- duplicate install is idempotent;
- newer unsupported DB/image schema fails closed;
- listing images is deterministic;
- image integrity revalidation after restart detects tampering;
- two projects may reference different installed images without copying bytes per project.

Run focused test, implement minimal tables/indexes, run GREEN, then:
```bash
node --test tests/runtime/v2-reference-state.test.mjs tests/runtime/v2-runtime-images.test.mjs
```

Commit:
```bash
git add v2/persistence/sqlite v2/runtime-images tests/runtime/v2-runtime-images.test.mjs
git commit -m "feat(v2): persist global runtime image registry"
```

---

### Task 3: Implement runtime compatibility decisions

**Files:**
- Create: `v2/runtime-images/compatibility.mjs`
- Test: `tests/runtime/v2-runtime-images.test.mjs`

**RED cases:**
- engine incompatible with image => structured denial;
- Codex adapter incompatible with target image => structured denial when project uses Codex;
- AGY adapter incompatible => equivalent denial;
- compatibility check never mutates project state;
- unknown/malformed compatibility metadata fails closed;
- a globally installed image may exist without being activatable for a project.

Implement pure deterministic compatibility logic. It must not inspect provider transcripts or local runtime copies.

Commit:
```bash
git add v2/runtime-images/compatibility.mjs tests/runtime/v2-runtime-images.test.mjs
git commit -m "feat(v2): enforce runtime image compatibility"
```

---

### Task 4: Implement lifecycle-safe project upgrade and rollback

**Files:**
- Create: `v2/runtime-images/manager.mjs`
- Modify: `v2/global/project-registry.mjs`
- Modify: `v2/persistence/sqlite/state.mjs`
- Test: `tests/runtime/v2-runtime-upgrade.test.mjs`

**RED cases:**
- upgrade from image A to B changes only the Project pin after B passes integrity/compatibility;
- provider-visible semantic change increments `instructionEpoch` exactly once;
- retry with same command/image is idempotent;
- LIVE incompatible mutation Operation blocks activation;
- stale/dirty/unknown Operation returns the existing Reconciler/actionable state rather than bypassing it;
- Project A upgrade cannot change Project B;
- rollback to already-installed compatible image updates pin and epoch without changing repository contents;
- failed activation leaves old pin intact.

Use explicit command IDs/CAS semantics consistent with existing durable lifecycle. Do not infer an upgrade from global engine version.

Verify:
```bash
node --test tests/runtime/v2-runtime-upgrade.test.mjs tests/runtime/v2-runtime-images.test.mjs
node --test tests/runtime/v2-domain-invariants.test.mjs
```

Commit:
```bash
git add v2/runtime-images v2/global/project-registry.mjs v2/persistence/sqlite/state.mjs tests/runtime/v2-runtime-upgrade.test.mjs
git commit -m "feat(v2): add project runtime upgrade and rollback"
```

---

### Task 5: Add global runtime CLI surfaces

**Files:**
- Modify: `v2/global/cli.mjs`
- Modify: `v2/global/orchestra.mjs` only if launcher routing requires it
- Test: `tests/runtime/v2-runtime-images.test.mjs`
- Test: `tests/runtime/v2-runtime-upgrade.test.mjs`

Add exact surfaces:
```text
orchestra runtime install <source>
orchestra runtime list
orchestra project upgrade <projectId> --runtime-image <imageId> --command-id <id>
orchestra project rollback <projectId> --runtime-image <imageId> --command-id <id>
```

**RED cases:**
- `runtime list` is read-only/non-initializing when no state exists;
- install verifies content before recording image;
- upgrade/rollback require explicit project + image + command ID;
- unknown image/project fails without mutation;
- CLI result exposes old/new pin and resulting instruction epoch;
- provider shims observe new epoch on next SessionStart and old observations get `SESSION_RUNTIME_STALE`.

Commit after GREEN:
```bash
git add v2/global v2/runtime-images tests/runtime/v2-runtime-*.test.mjs
git commit -m "feat(v2): expose global runtime lifecycle commands"
```

---

### Task 6: Prove the bootstrap recovery law

**Files:**
- Test: `tests/runtime/v2-runtime-upgrade.test.mjs`
- Modify only if tests require neutral wiring: `v2/global/reconciliation.mjs`, `v2/runtime-images/manager.mjs`

Create the permanent regression where:
1. Project is pinned to image N.
2. N leaves a stale recoverable or dirty Operation.
3. Global engine has image N+1 installed.
4. Project activation to N+1 may remain blocked until lifecycle is safe.
5. **Global status/recover/resolve-dirty using current engine remains executable regardless of the broken N pin.**
6. After reconciliation, N+1 activation succeeds.

RED must fail if recovery dispatches through the broken pinned runtime.

Verify:
```bash
node --test tests/runtime/v2-runtime-upgrade.test.mjs
```

Commit:
```bash
git add v2/global/reconciliation.mjs v2/runtime-images/manager.mjs tests/runtime/v2-runtime-upgrade.test.mjs
git commit -m "test(v2): enforce runtime bootstrap recovery independence"
```

---

### Task 7: Portable path/integrity coverage and milestone closure

**Files:**
- Modify: `.github/workflows/orchestra-v2-persistence.yml`

Add Node 24 Ubuntu/Windows runs for:
```bash
node --test tests/runtime/v2-runtime-images.test.mjs tests/runtime/v2-runtime-upgrade.test.mjs
```

Final local verification:
```bash
node --test tests/runtime/v2-runtime-images.test.mjs tests/runtime/v2-runtime-upgrade.test.mjs
node --test tests/runtime/v2-codex-global-adapter.test.mjs tests/runtime/v2-antigravity-global-adapter.test.mjs tests/runtime/v2-provider-symmetry.test.mjs
node --test tests/runtime/v2-domain-invariants.test.mjs tests/runtime/v2-reference-state.test.mjs tests/runtime/v2-continuation-capsule.test.mjs
npm run test:firewall
npm run check:runtimes
npm run check:runtime-core
npm test
```

Push exact head; require canonical Ubuntu/Windows/v1-compatibility green; Sol records head/run; mark PR ready; no merge.
