# V2-10 — Migration and De-localization Implementation Plan

> **For Codex execution:** Sol orchestrates; Luna implements. No investigation tasks. Legacy state is evidence to classify, never authority to trust implicitly. Ambiguous/malformed state must not be auto-healed destructively.

**Goal:** Migrate eligible Orchestra 1.x projects into the global v2 control plane, preserve recoverable/private state, install only thin provider shims, provide explicit rollback, and remove project-local runtime copies only after verified activation.

**Architecture:** Migration runs from the global engine above the legacy runtime. It inventories known v1 surfaces, maps each item into one of four closed dispositions, imports only supported durable facts, reconciles transient state using v2 semantics, activates v2 shims, verifies, and only then removes managed local runtime copies under an explicit cleanup gate.

**Base:** exact reviewed V2-9 head.

**Allowed dispositions:**
- `CLEAN_IMPORT`
- `RECOVERABLE_IMPORT`
- `PRIVATE_ARCHIVE`
- `UNSUPPORTED_BLOCKED`

No fifth disposition is permitted without a spec change.

---

### Task 1: Implement deterministic legacy inventory

**Owner:** Luna  
**Acceptance:** Sol

**Files:**
- Create: `v2/migration/inventory.mjs`
- Test: `tests/runtime/v2-migration.test.mjs`

Inventory only known Orchestra-managed legacy surfaces, including when present:
- `.orchestra/**` managed state;
- `.codex/orchestra-state/**` and `.codex/astra-orchestra/**` managed runtime/state;
- `.agents/**` Orchestra-managed runtime/state;
- legacy Work Lease/session binding state;
- delegation/parallel-group state;
- candidate/evidence/continuation artifacts with recognized schemas;
- provider hook/config files managed by Orchestra.

**RED cases:**
- read-only inventory makes no project/global mutation;
- known valid records include path, schema/version, digest, category and proposed disposition basis;
- unknown files inside project are never claimed as Orchestra-managed by path proximity alone;
- symlinks/junctions/path traversal do not escape project root;
- malformed JSON/schema is reported factually, not normalized into healthy state;
- raw private artifacts are identified as private/archive candidates rather than copied into global Experience.

Run:
```bash
node --test tests/runtime/v2-migration.test.mjs
```
Expected: FAIL because migration modules do not exist.

Commit after GREEN:
```bash
git add v2/migration/inventory.mjs tests/runtime/v2-migration.test.mjs
git commit -m "feat(v2): inventory legacy Orchestra project state"
```

---

### Task 2: Implement the four-way migration classifier

**Files:**
- Create: `v2/migration/transient-classifier.mjs`
- Test: `tests/runtime/v2-migration.test.mjs`
- Test: `tests/runtime/v2-tsuzuki-f7-migration.test.mjs`

**Classification rules:**
- `CLEAN_IMPORT`: recognized durable fact with complete integrity/provenance and no unresolved transient authority.
- `RECOVERABLE_IMPORT`: recognized transient or recoverable fact that can be represented in v2 without claiming success/liveness.
- `PRIVATE_ARCHIVE`: recognized private history/artifact retained for user recovery/audit but excluded from authority/Experience.
- `UNSUPPORTED_BLOCKED`: malformed, ambiguous, unsupported schema/version or state whose safe meaning cannot be proven.

**Permanent Tsuzuki F7 fixture:**
```text
groupId = tsuzuki-f7-g2-parallel-2
state = RUNNING
createdAt = 2026-10-16T15:27:58.440Z
updatedAt = 2026-10-16T15:27:58.446Z
memberArtifactIds = []
compositeArtifactId = null
survivingWorkspaces = 2
ownerProcessProof = absent
canonicalPromotion = false
runtime = v1.4.2
```

RED must prove this fixture is never classified LIVE or successful solely because persisted state says RUNNING. It must become recoverable/blocked according to available imported facts and remain eligible for official v2 reconciliation.

Commit:
```bash
git add v2/migration/transient-classifier.mjs tests/runtime/v2-migration.test.mjs tests/runtime/v2-tsuzuki-f7-migration.test.mjs
git commit -m "feat(v2): classify legacy migration state conservatively"
```

---

### Task 3: Import supported durable state transactionally

**Files:**
- Create: `v2/migration/import.mjs`
- Reuse: `v2/global/project-registry.mjs`
- Reuse: `v2/persistence/sqlite/state.mjs`
- Reuse: `v2/persistence/blob-store.mjs`
- Test: `tests/runtime/v2-migration.test.mjs`

**RED cases:**
- migration registers/resolves exactly one Project before importing project-scoped facts;
- supported durable Work/candidate/evidence/continuation facts are imported only with verified schema/digest/provenance;
- historical session IDs do not become authority;
- imported Work identity/generation cannot collide with another Project;
- retry with same command ID is idempotent across restart;
- transaction failure leaves no half-imported active Work head;
- PRIVATE_ARCHIVE data is sealed/referenced separately and never enters Experience automatically;
- UNSUPPORTED_BLOCKED prevents activation but preserves inventory evidence.

Do not reinterpret malformed legacy authority records into new v2 Work/Operation facts.

Verify:
```bash
node --test tests/runtime/v2-migration.test.mjs tests/runtime/v2-reference-state.test.mjs
```

Commit:
```bash
git add v2/migration/import.mjs tests/runtime/v2-migration.test.mjs
git commit -m "feat(v2): import supported legacy durable state"
```

---

### Task 4: Import transient execution only as v2-reconcilable facts

**Files:**
- Modify: `v2/migration/import.mjs`
- Modify: `v2/migration/transient-classifier.mjs`
- Reuse: `v2/global/reconciliation.mjs`
- Test: `tests/runtime/v2-tsuzuki-f7-migration.test.mjs`

**RED cases:**
- legacy RUNNING without factual live owner never imports as LIVE;
- supported stale operation imports with enough provenance to be inspected/recovered by v2;
- ambiguous workspace identity becomes UNKNOWN/blocked rather than cleanup-authorized;
- dirty surviving workspace is preserved and routed to `resolve-dirty` semantics;
- canonical workspace mutation/promotion is never fabricated;
- migrated F7-shaped orphan can be explained by `project status` and cannot create a permanent opaque lock;
- unsupported legacy runtime version/state remains `UNSUPPORTED_BLOCKED` with actionable diagnostic.

Commit:
```bash
git add v2/migration tests/runtime/v2-tsuzuki-f7-migration.test.mjs
git commit -m "feat(v2): import legacy transient state for reconciliation"
```

---

### Task 5: Add migration CLI inspect/apply and explicit rollback

**Files:**
- Create: `v2/migration/rollback.mjs`
- Modify: `v2/global/cli.mjs`
- Test: `tests/runtime/v2-migration.test.mjs`

Add exact surfaces:
```text
orchestra project migrate inspect <workspace>
orchestra project migrate apply <workspace> --command-id <id>
orchestra project migrate rollback <projectId> --command-id <id>
```

**RED cases:**
- inspect is read-only and does not create registry state;
- apply refuses `UNSUPPORTED_BLOCKED` inventory;
- apply records migration manifest/digests/dispositions;
- repeated apply is idempotent;
- rollback restores pre-activation integration state while preserving v2 audit/import records as inactive history;
- rollback never deletes user/private archive data;
- cross-project command IDs cannot replay another Project migration.

Commit:
```bash
git add v2/migration/rollback.mjs v2/global/cli.mjs tests/runtime/v2-migration.test.mjs
git commit -m "feat(v2): expose controlled project migration lifecycle"
```

---

### Task 6: Activate thin provider shims and verify v2 before local-runtime cleanup

**Files:**
- Create: `v2/migration/shim-activation.mjs`
- Reuse: `v2/providers/codex/shim-manager.mjs`
- Reuse: `v2/providers/antigravity/shim-manager.mjs`
- Test: `tests/runtime/v2-migration.test.mjs`

**RED cases:**
- activation installs only the appropriate v2 thin shim(s);
- activation does not delete `.codex/astra-orchestra`, `.agents`, or legacy `.orchestra` runtime before verification;
- provider SessionStart/attach through global v2 must succeed before cleanup gate is available;
- global status/recovery must work on imported transient state before cleanup;
- failed verification leaves legacy runtime intact and rollback available;
- v2 activation never silently falls back to v1 authority.

Commit:
```bash
git add v2/migration/shim-activation.mjs tests/runtime/v2-migration.test.mjs
git commit -m "feat(v2): activate migrated projects through thin shims"
```

---

### Task 7: Remove only proven managed local runtime copies after explicit cleanup gate

**Files:**
- Create: `v2/migration/cleanup.mjs`
- Modify: `v2/global/cli.mjs`
- Test: `tests/runtime/v2-migration.test.mjs`

Add an explicit cleanup command only after verified activation, for example:
```text
orchestra project migrate cleanup <projectId> --command-id <id>
```

The command may remove only files that:
- appear in the recorded migration inventory as Orchestra-managed;
- still match the inventoried digest/type or an explicitly expected shim replacement state;
- are not PRIVATE_ARCHIVE/user-owned data;
- are not outside the canonical project root;
- are no longer required for rollback according to the migration manifest.

**RED cases:**
- changed/unrecognized local file blocks cleanup;
- symlink/junction egress blocks cleanup;
- dirty private data is preserved;
- verified managed runtime copies are removed idempotently;
- resulting project contains only permitted thin shims/identity marker;
- v2 provider attach still works after cleanup.

Commit:
```bash
git add v2/migration/cleanup.mjs v2/global/cli.mjs tests/runtime/v2-migration.test.mjs
git commit -m "feat(v2): remove verified legacy runtime copies after migration"
```

---

### Task 8: Close V2-10 with Tsuzuki fixture, portability and v1 compatibility

**Files:**
- Modify: `.github/workflows/orchestra-v2-persistence.yml`

Final local verification:
```bash
node --test tests/runtime/v2-migration.test.mjs tests/runtime/v2-tsuzuki-f7-migration.test.mjs
node --test tests/runtime/v2-codex-global-adapter.test.mjs tests/runtime/v2-antigravity-global-adapter.test.mjs tests/runtime/v2-runtime-upgrade.test.mjs
node --test tests/runtime/v2-global-experience-store.test.mjs tests/runtime/v2-cross-project-rsi.test.mjs tests/runtime/v2-rsi-replay.test.mjs
node --test tests/runtime/v2-domain-invariants.test.mjs tests/runtime/v2-reference-state.test.mjs tests/runtime/v2-continuation-capsule.test.mjs
npm run test:firewall
npm run test:installers
npm run check:contamination
npm run check:runtimes
npm run check:runtime-core
npm test
```

Add Ubuntu/Windows Node 24 migration suites to the canonical v2 workflow. Never point CI at the user's real Tsuzuki checkout; use the permanent synthetic F7 fixture.

Push exact head, require all v2/v1 compatibility jobs green, update PR evidence, mark ready, no merge.
