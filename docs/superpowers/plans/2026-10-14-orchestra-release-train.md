# Orchestra Release Train Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate Orchestra release preparation and publication while keeping release PR merge as the explicit operator authorization boundary.

**Architecture:** A manual preparation workflow calls repository-owned Node release tooling to compute/update version metadata, generate release notes, validate the complete prepared state, push `release/vX.Y.Z`, and open a PR. A separate publisher runs only after successful canonical CI on `main`, proves the exact SHA came from the matching release PR and is a two-parent merge commit, then idempotently creates the annotated tag and GitHub Release.

**Tech Stack:** Node.js 20, `node:test`, Git, GitHub Actions, GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-10-14-orchestra-release-train-design.md`

## Global Constraints

- Ordinary green merges to `main` must not publish releases.
- Operator authorization is the merge-commit integration of a dedicated `release/vX.Y.Z` PR.
- Preparation requires an explicit `patch`, `minor`, or `major` choice.
- Conventional Commits inference is advisory only.
- Prepared release state must pass full regression, Doctor, contamination, runtime integrity, and release-readiness checks before push.
- Publication requires successful canonical `CI` on the exact resulting `main` SHA.
- Release authorization requires that exact SHA to be the two-parent merge commit of the matching release PR; squash and rebase fail closed.
- Existing conflicting tags fail closed.
- Do not add a third-party release action.

## Review Focus

- Existing tag on a different SHA must block rather than retag.
- Partial publication where tag exists but GitHub Release does not must recover idempotently.
- A normal `main` CI run at the current already-released version must no-op.
- Requested bump differing from inferred bump must remain reviewable and operator-controlled.
- Release PRs merged by squash or rebase must not accidentally satisfy exact-SHA authorization.
- Failed automated PR creation must not strand a release branch that blocks a clean rerun.

---

### Task 1: Release version and preparation contracts

**Files:**
- Create: `scripts/release/versioning.mjs`
- Create: `scripts/release/prepare-release.mjs`
- Create: `tests/release/release-train.test.mjs`

**Interfaces:**
- Produces: `bumpVersion(version, bump)`, `suggestBump(commits)`, `prepareRelease(options)`.
- Produces CLI outputs `version`, `tag`, `base_tag`, `requested_bump`, `suggested_bump`, `branch`, and `notes_path` through `GITHUB_OUTPUT`.

- [ ] **Step 1: Write failing tests for SemVer increments, Conventional Commits precedence, canonical metadata updates, generated notes, and base-tag/version drift.**
- [ ] **Step 2: Run `node --test tests/release/release-train.test.mjs` and verify RED because the release modules do not exist.**
- [ ] **Step 3: Implement the minimal release versioning and preparation modules.**
- [ ] **Step 4: Re-run the release-train tests and verify GREEN.**

### Task 2: Publication authorization contract

**Files:**
- Create: `scripts/release/publish-guard.mjs`
- Test: `tests/release/release-train.test.mjs`
- Test: `tests/release/release-merge-method.test.mjs`

**Interfaces:**
- Consumes: package version resolved by the publisher workflow and exact Git topology from the checked-out main SHA.
- Produces: `validatePublishAuthorization({ version, sha, ciConclusion, parentCount, pullRequests })`.

- [ ] **Step 1: Add failing tests that require successful CI plus a merged `release/vX.Y.Z` PR whose merge SHA is the exact verified main SHA, and reject single-parent integration.**
- [ ] **Step 2: Run the release-train tests and verify RED.**
- [ ] **Step 3: Implement the fail-closed publication guard including the two-parent merge-commit requirement.**
- [ ] **Step 4: Re-run the release-train tests and verify GREEN.**

### Task 3: GitHub release workflows

**Files:**
- Create: `.github/workflows/prepare-release.yml`
- Create: `.github/workflows/publish-release.yml`
- Test: `tests/release/release-train.test.mjs`

**Interfaces:**
- Consumes: release preparation and publish-guard CLIs.
- Produces: manual Release PR creation and exact-CI-gated publication.

- [ ] **Step 1: Add failing textual contract tests for workflow triggers, permissions, exact SHA checkout, PR association, tagging, publication, prepare/publish separation, prepared-state preflight, and failure cleanup.**
- [ ] **Step 2: Run the release-train tests and verify RED because the workflows do not exist or do not satisfy the hardened contract.**
- [ ] **Step 3: Implement `Prepare Release` with explicit bump selection, release metadata generation, runtime regeneration, full prepared-state preflight, branch push, PR creation, and branch cleanup on PR-creation failure.**
- [ ] **Step 4: Implement `Publish Release` on successful `workflow_run` for `CI`, with exact-SHA PR proof, merge-topology proof, and idempotent tag/release handling.**
- [ ] **Step 5: Re-run the release-train tests and verify GREEN.**

### Task 4: Integrate release gates and documentation

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/release/1.x-checklist.md`

**Interfaces:**
- Consumes: `tests/release/*.test.mjs` and generic `release:readiness`.
- Produces: permanent CI coverage and documented operator workflow.

- [ ] **Step 1: Add `test:release`, make `release:readiness` version-generic, and include release tests in full regression/CI.**
- [ ] **Step 2: Update the release checklist so merge-commit integration of the release PR is the explicit operator approval and manual tag/release creation is no longer routine.**
- [ ] **Step 3: Run release tests plus existing release-readiness tests.**
- [ ] **Step 4: Run full repository CI on the branch and perform final review before integration.**
