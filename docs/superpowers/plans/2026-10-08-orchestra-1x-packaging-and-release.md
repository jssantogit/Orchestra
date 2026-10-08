# Orchestra 1.x Packaging, Labs, Doctor & Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the 1.x architecture by separating development source from installed runtime artifacts, replacing hardcoded runtime path knowledge with manifests, making Dream/Jev explicit zero-authority Labs, simplifying Doctor, and preparing a governed 1.x release with a documented 0.10 rollback path.

**Architecture:** Top-level `core/`, `providers/`, `runtime/`, `labs/`, and `schemas/` become canonical source. `runtime/manifests/*.json` declare build/install ownership. A deterministic runtime builder produces self-contained Codex and Antigravity payloads; project runtime managers become thin wrappers around shared manifest-driven install/update/rollback primitives. Labs consume neutral artifacts/events and are never part of authority/acceptance. Repository/release mutations occur only after code/runtime verification and an explicit operator gate.

**Tech Stack:** Node.js ESM, `node:test`, JSON manifests/schemas, existing project-runtime managers and installer tests, GitHub Actions, current Doctor/contamination checks.

**Spec:** `docs/superpowers/specs/2026-10-08-orchestra-1x-direct-work-architecture.md`

**Prerequisites:** Core Foundation, Direct Work, Work Leases, and Provider Adapters plans complete and green.

## Global Constraints

- Installed provider runtimes remain self-contained and require no Orchestra checkout or Orchestra `node_modules`.
- Canonical development source is never edited through generated/distribution paths.
- Project-owned state survives install/update/rollback and must not pollute normal `git status` in downstream projects.
- Runtime manifests, not giant hand-maintained arrays in Doctor, define managed/preserved assets.
- Labs have `authority=NONE`: no acceptance, capability grants, Work Lease ownership, or mutation authority.
- Physical Dream/Jev moves happen only after compatibility launchers and manifest tests are green.
- Old session handoff remains recovery-only for the first stable 1.x migration window; removal is a later compatibility decision.
- Branch protection/rulesets, stale-branch deletion, tags/releases, and version publication are external repository mutations and require explicit operator approval at execution time.

## Review Focus

- A missing or unexpected managed runtime asset must fail build/Doctor deterministically — pinned by manifest tests.
- Updating a project must preserve `.orchestra/state`, provider-owned state/telemetry, and locally ignored runtime state — pinned by installer tests.
- Installed runtime smoke tests must run in a temporary repo with no Orchestra source tree/node_modules — pinned by `tests/installers/self-contained-runtime.test.mjs`.
- Labs must remain unable to satisfy evidence/acceptance or acquire lease/capability even if their output is syntactically valid — pinned by labs authority tests.
- A release cannot be declared ready when version, runtime manifest version, migration docs, CI baseline, or release notes disagree — pinned by release-readiness tests.

---

### Task 1: Define manifest-driven runtime ownership

**Files:**
- Create: `runtime/manifests/core.json`
- Create: `runtime/manifests/codex.json`
- Create: `runtime/manifests/antigravity.json`
- Create: `runtime/manifest-loader.mjs`
- Create: `schemas/runtime-manifest.v1.schema.json`
- Create: `tests/runtime/runtime-manifest.test.mjs`
- Modify: schema build/check inputs from Core Foundation.

**Interfaces:**
- `loadRuntimeManifest(name) -> validated manifest`.
- Manifest fields include `schema`, `runtime`, `version`, `sourceRoots`, `managedAssets`, `preservedProjectPaths`, `generatedInputs`, `entrypoints`, and `healthChecks`.
- Assets describe source-to-output mapping explicitly; no glob may escape declared canonical roots.

- [ ] **Step 1: Write RED manifest tests**
  - Codex manifest fully describes current `.codex/config.toml`, hooks, agents, provider adapter/core payload, entrypoints.
  - Antigravity manifest fully describes hooks, agents, skills/provider/core payload, GEMINI entrypoint and temporary compatibility launchers.
  - Unknown/duplicate/output-colliding paths reject.
  - Preserved paths cannot overlap managed outputs.

- [ ] **Step 2: Confirm RED**
  - Run: `node --test tests/runtime/runtime-manifest.test.mjs`

- [ ] **Step 3: Add schema + manifest loader and populate manifests from the current proven runtime image**

- [ ] **Step 4: Verify GREEN and commit**
  - Commit message: `feat(runtime): add manifest-driven runtime ownership`

---

### Task 2: Build self-contained provider runtime distributions from canonical source

**Files:**
- Create: `runtime/runtime-builder.mjs`
- Create: `scripts/build-runtimes.mjs`
- Create: `scripts/check-runtime-build.mjs`
- Create: `tests/runtime/runtime-builder.test.mjs`
- Create generated build root: `dist/runtime/codex/**`
- Create generated build root: `dist/runtime/antigravity/**`
- Modify: `package.json`
- Modify: `.gitignore` according to chosen generated-artifact policy.

**Interfaces:**
- `buildRuntime({ runtime, outputDir }) -> { runtime, manifestHash, files, version }`.
- CLI `npm run build:runtimes` rebuilds both runtime images from canonical core/provider source and provider static templates.
- `npm run check:runtimes` builds into a temporary directory and compares deterministic file manifests against committed/expected build metadata.

- [ ] **Step 1: Write RED builder tests**
  - Output has no import reaching top-level `core/`, `providers/`, `schemas/`, or Orchestra `node_modules` outside the built image.
  - Generated schema validators are included.
  - Provider images do not contain the other provider's model IDs/hook code.
  - Same source produces same manifest/hash.

- [ ] **Step 2: Confirm RED**
  - Run: `node --test tests/runtime/runtime-builder.test.mjs`

- [ ] **Step 3: Implement deterministic builder**
  - Consume runtime manifests only.
  - Preserve executable modes/symlinks where explicitly declared.
  - Stamp bounded build metadata; do not stamp nondeterministic timestamps into content hashes.

- [ ] **Step 4: Remove the temporary source mirror as canonical distribution input**
  - `scripts/sync-runtime-core.mjs` becomes a compatibility checker/no-op migration helper or is removed only after all callers switch to builder output.
  - Provider runtime source directories stop containing hand-maintained duplicate core/provider implementations.

- [ ] **Step 5: Verify GREEN and commit**
  - Run: `npm run build:schemas && npm run build:runtimes && npm run check:runtimes && node --test tests/runtime/runtime-builder.test.mjs`
  - Commit message: `build(runtime): generate self-contained provider distributions`

---

### Task 3: Replace duplicate project runtime managers with shared manifest-driven installer primitives

**Files:**
- Create: `runtime/project-runtime-manager.mjs`
- Create: `runtime/project-state-ignore.mjs`
- Modify: `runtimes/codex/.codex/astra-orchestra/codex-runtime-manager.mjs`
- Modify: `runtimes/antigravity/.agents/skills/orchestra/project-runtime-manager.mjs`
- Modify: `scripts/install-codex.mjs`
- Modify: `scripts/install-antigravity.mjs`
- Modify: `scripts/orchestra-codex-project.mjs`
- Modify: `scripts/orchestra-project.mjs`
- Modify: `tests/installers/codex-project-runtime-manager.test.mjs`
- Modify: `tests/installers/project-runtime-manager.test.mjs`
- Create: `tests/installers/manifest-project-runtime-manager.test.mjs`
- Create: `tests/installers/project-state-ignore.test.mjs`

**Interfaces:**
- `inspectProjectRuntime({ targetDir, runtimeManifest, builtRuntime })`.
- `installProjectRuntime(...)`, `updateProjectRuntime(...)`, `rollbackProjectRuntime(...)` share common copy/backup/hash/quiescence semantics.
- Provider runtime-manager files become compatibility wrappers providing provider-specific state/quiescence adapters.
- `ensureProjectStateIgnored(targetDir)` manages bounded entries in `.git/info/exclude` for Orchestra-owned volatile state (including `.orchestra/state/`, provider telemetry/artifacts/runtime-management) without modifying tracked product `.gitignore`.

- [ ] **Step 1: Write RED shared-manager parity tests**
  - Existing Codex/AGY dry-run/add/change/remove/preserve/rollback cases produce the same normalized results through shared manager.
  - Runtime updates consume built manifest images, not source-tree runtime directories.

- [ ] **Step 2: Write RED downstream git-status cleanliness tests**
  - In a temporary Git repo, installation creates project-owned runtime state but `git status --short` does not show volatile Orchestra state because bounded `.git/info/exclude` entries are installed.
  - Existing user exclude content is preserved byte-for-byte outside the Orchestra managed block.
  - Uninstall/update does not erase user entries.

- [ ] **Step 3: Implement common manager + compatibility wrappers**

- [ ] **Step 4: Verify installer suites**
  - Run: `npm run test:installers && node --test tests/installers/manifest-project-runtime-manager.test.mjs tests/installers/project-state-ignore.test.mjs`

- [ ] **Step 5: Commit**
  - Commit message: `refactor(runtime): unify manifest-driven project installers`

---

### Task 4: Prove installed runtimes are self-contained

**Files:**
- Create: `tests/installers/self-contained-runtime.test.mjs`
- Create: `tests/fixtures/runtime-smoke-project/**` only if a static fixture is needed; prefer temporary fixtures generated by the test.
- Modify: provider installer tests as required.

**Interfaces:**
- Smoke harness creates a temporary Git project, installs one provider runtime, removes/unsets access to the Orchestra source checkout and repo `node_modules`, then imports/runs health-safe runtime entrypoints and schema/core checks from inside the installed project.

- [ ] **Step 1: Write RED Codex/Antigravity isolated smoke tests**
  - Runtime can validate canonical packets, load model catalog/adapter, evaluate read-only routing/authority health, and run provider Doctor checks with no external imports.

- [ ] **Step 2: Fix any builder/manifest leakage exposed by the smoke test; do not add fallback imports to Orchestra source**

- [ ] **Step 3: Verify GREEN and commit**
  - Run: `node --test tests/installers/self-contained-runtime.test.mjs && npm run test:installers`
  - Commit message: `test(runtime): prove installed runtimes are self-contained`

---

### Task 5: Make Dream and Jev explicit zero-authority Labs

**Files:**
- Create: `labs/dream/README.md`
- Create: `labs/jev/README.md`
- Create: `labs/lab-authority.mjs`
- Create: `tests/labs/lab-authority.test.mjs`
- Modify/move: `experiments/jev/**` to `labs/jev/**` only after compatibility launcher tests exist.
- Modify/move: canonical Dream source from provider runtime tree to `labs/dream/**` only after compatibility launcher/build manifest support exists.
- Modify: `runtime/manifests/antigravity.json`
- Modify: `runtime/manifests/codex.json` only for any thin observer/launcher payload actually required.
- Modify: existing Dream/Jev tests and launch scripts to canonical lab paths.

**Interfaces:**
- `LAB_AUTHORITY = 'NONE'`.
- `assertLabOperationAllowed(operation)` allows bounded observation/analysis/storage only; denies `ACCEPT_WORK`, `GRANT_CAPABILITY`, `CLAIM_WORK_LEASE`, `MUTATE_PRODUCT` by default.
- Runtime compatibility launchers may invoke packaged lab functionality but cannot change this authority contract.

- [ ] **Step 1: Write RED lab authority tests before moving source**
  - Jev/Dream outputs cannot satisfy acceptance or evidence merely by being lab results.
  - Labs cannot acquire a Work Lease/capability.
  - Existing shadow/canary semantics that are observational remain readable.

- [ ] **Step 2: Add compatibility launchers and manifest mappings, then move Jev canonical source**
  - Run Jev tests after move.

- [ ] **Step 3: Move Dream canonical source in small groups with existing huge Dream suite as regression oracle**
  - Keep provider-installed compatibility paths only when needed by runtime launchers; generated/build output owns those paths.

- [ ] **Step 4: Verify Labs + provider/runtime suites**
  - Run: `npm run test:dream && npm run test:jev && node --test tests/labs/lab-authority.test.mjs && npm run test:firewall`

- [ ] **Step 5: Commit**
  - Commit message: `refactor(labs): isolate Dream and Jev from authority`

---

### Task 6: Replace path-hardcoded Doctor with schema/manifest/invariant health checks

**Files:**
- Create: `runtime/doctor.mjs`
- Create: `tests/runtime/doctor.test.mjs`
- Modify: `scripts/doctor.sh` to a thin launcher or replace with a compatibility shell wrapper.
- Modify: `package.json`
- Modify: runtime manifests' `healthChecks`.

**Interfaces:**
- `runDoctor({ repoRoot, runtime = 'all' }) -> { healthy, checks[] }`.
- Checks include schema validator freshness, runtime build freshness, manifest completeness, source/provider firewall, generated/install image imports, project/runtime metadata version coherence, and declared focused tests/syntax checks.
- Doctor discovers required assets from manifests; no giant per-provider required-file arrays remain.

- [ ] **Step 1: Write RED Doctor tests**
  - Missing declared asset, stale schema validator, stale runtime build, cross-provider import, invalid manifest, and version mismatch each produce one named failing health check.
  - Labs are not required authority assets merely because canonical lab files exist.

- [ ] **Step 2: Implement manifest-driven Doctor and keep `npm run doctor` interface stable**

- [ ] **Step 3: Verify Doctor on clean repo and intentional broken fixtures**
  - Run: `node --test tests/runtime/doctor.test.mjs && npm run doctor`

- [ ] **Step 4: Commit**
  - Commit message: `refactor(doctor): validate manifests schemas and invariants`

---

### Task 7: Align documentation, versioning, migration and release-readiness checks

**Files:**
- Create: `docs/migrations/0.10-to-1.x.md`
- Create: `docs/release/1.x-checklist.md`
- Create: `scripts/release-readiness.mjs`
- Create: `tests/release/release-readiness.test.mjs`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/project-runtime.md`
- Modify: `docs/codex.md`
- Modify: `docs/antigravity.md`
- Modify: `docs/dream-layer.md`
- Modify: `package.json`
- Modify: runtime manifest versions/runtime metadata version declarations.

**Interfaces:**
- `checkReleaseReadiness({ expectedVersion }) -> { ready, failures[] }` compares package version, runtime manifest versions, migration docs, build/schema freshness, required test declarations, and release checklist state.
- Do **not** bump to final `1.0.0` until code/runtime behavior is complete and the operator starts the release task; during development use a consistent prerelease such as `1.0.0-rc.0` only if a version bump is required by runtime metadata tests.

- [ ] **Step 1: Write RED release consistency tests**
  - Version mismatch, stale build/validator, missing migration doc, or missing rollback instructions rejects readiness.

- [ ] **Step 2: Write migration/rollback docs**
  - 0.10 session handoff behavior → 1.x Work Lease behavior.
  - Direct Work `off|shadow|on` rollback during migration window.
  - Authority `session|dual|lease` rollback during migration window.
  - Runtime update/rollback and project-state preservation.

- [ ] **Step 3: Update top-level/provider/Labs docs to the final architecture and remove claims superseded by 1.x**

- [ ] **Step 4: Verify docs/version/build readiness mechanically**
  - Run: `node --test tests/release/release-readiness.test.mjs && node scripts/release-readiness.mjs --version 1.0.0-rc.0` (or the approved release candidate version).

- [ ] **Step 5: Commit**
  - Commit message: `docs(release): prepare Orchestra 1.x migration`

---

### Task 8: Final full-system verification before repository/release mutations

**Files:**
- No planned product changes; only narrowly fix verified regressions.

**Interfaces:**
- This is the technical go/no-go gate. It does not publish, merge, delete branches, or create a release.

- [ ] **Step 1: Ensure generated/build artifacts are current**
  - Run: `npm run build:schemas && npm run build:runtimes && npm run check:schemas && npm run check:runtimes && git diff --check`

- [ ] **Step 2: Run full regression**
  - Run: `npm test`
  - Expected: PASS.

- [ ] **Step 3: Run installer self-contained smoke tests, Doctor and contamination/firewall checks**
  - Run: `node --test tests/installers/self-contained-runtime.test.mjs && npm run doctor && npm run check:contamination && npm run test:firewall`
  - Expected: PASS/healthy/clean.

- [ ] **Step 4: Run representative Direct Work/Work Lease performance scenarios and store comparison results**
  - Verify no regression to repeated classification/rediscovery/delegation chains for normal tasks.

- [ ] **Step 5: Run release-readiness check against the chosen release candidate version**

- [ ] **Step 6: Request whole-branch independent code/security review; resolve only confirmed findings and repeat affected gates**

---

### Task 9: Operator-gated GitHub governance and stable release

**External mutations — DO NOT execute without explicit operator approval at this task.**

**Repository actions:**
- Configure a `main` ruleset/branch policy requiring the authoritative CI gate before merge and preventing accidental direct destructive changes, using the strongest policy supported by the repository/account.
- Re-query merged/stale branches and delete only branches proven merged and approved for cleanup.
- Merge the verified 1.x implementation through the approved PR/merge policy.
- Bump final product/runtime manifest versions consistently to the operator-approved stable version (intended target: `1.0.0`, unless changed before release).
- Re-run release-readiness and final CI on the exact release SHA.
- Create/update GitHub Release notes describing Direct Work, Work Leases, provider adapters, migration/rollback, and known compatibility window.

- [ ] **Step 1: Present final exact SHA, CI evidence, review outcome, proposed ruleset, branch deletion list, version, and release notes to operator**

- [ ] **Step 2: Receive explicit operator approval for external governance/release mutations**

- [ ] **Step 3: Apply approved repository policy/cleanup only; re-read state afterward to verify it matches the approved list**

- [ ] **Step 4: Produce final version commit, run exact-SHA CI and release-readiness**

- [ ] **Step 5: Create the stable release only after exact-SHA gates pass**

- [ ] **Step 6: Record final migration/release evidence in repository docs/release notes**
