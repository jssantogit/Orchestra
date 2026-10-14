# Orchestra Release Train Design

Date: 2026-10-14
Status: approved

## Goal

Automate Orchestra release preparation, tagging, and GitHub Release publication without making publication implicit in ordinary merges to `main`.

## Core authority rule

Automation executes release mechanics; the operator authorizes publication by merging a dedicated `release/vX.Y.Z` pull request.

A normal feature, fix, documentation, or hardening merge to `main` must never publish a release merely because CI is green.

## Preparation flow

`Prepare Release` is a manual GitHub Actions workflow.

The operator must explicitly choose one semantic-version bump: `patch`, `minor`, or `major`. A placeholder choice must fail closed.

Preparation must:

- resolve the latest stable `vX.Y.Z` tag;
- require that the latest tag version matches the current `package.json` version;
- inspect commits since that tag and produce an advisory Conventional Commits bump suggestion;
- apply the operator-requested bump even when it differs from the suggestion, while surfacing the mismatch for review;
- update canonical version sources: `package.json`, root `package-lock.json`, and `runtime/manifests/{core,codex,antigravity}.json`;
- make `release:readiness` derive its expected version from `package.json` rather than a hardcoded version;
- generate reviewable release notes under `docs/release/vX.Y.Z.md`;
- regenerate deterministic runtime artifacts;
- run release-focused validation before pushing;
- create branch `release/vX.Y.Z` and open a PR to `main`;
- never create a tag or GitHub Release.

For the current repository state, `v1.0.1` plus the post-release feature work should lead the Conventional Commits heuristic to suggest a `minor` bump, i.e. `v1.1.0`.

## Publication flow

`Publish Release` is triggered only after the canonical `CI` workflow completes.

Publication is permitted only when all of the following are true:

1. the triggering CI run concluded `success`;
2. the CI run was a `push` run for branch `main`;
3. the publisher checks out exactly `github.event.workflow_run.head_sha`;
4. generated notes exist for the `package.json` version;
5. the exact SHA is associated through GitHub's commit-to-PR API with a merged PR whose base is `main` and whose head is exactly `release/vX.Y.Z`;
6. the PR's merge commit SHA matches the exact verified SHA.

Release PRs therefore must use merge or squash, not rebase.

The publisher then creates an annotated `vX.Y.Z` tag and a GitHub Release using the generated notes, augmented at publication time with the exact main SHA and canonical CI run URL.

## Idempotency and fail-closed behavior

The publisher must distinguish three states:

- tag absent + release absent: create both;
- tag present on the exact authorized SHA + release absent: create only the release;
- tag and release both present for the exact authorized SHA: no-op success.

If an existing tag points anywhere other than the exact authorized SHA, publication fails closed.

A successful ordinary `main` CI run with no generated notes for the current package version is a no-op, not a release.

## Security boundary

The `workflow_run` publisher receives write authority only after a successful `main` CI run. It must not publish from pull-request CI, feature branches, failed CI, or an unassociated commit.

No third-party release action is required. The implementation uses repository-owned Node scripts, official GitHub Actions checkout/setup-node actions, Git, the GitHub CLI, and the workflow `GITHUB_TOKEN`.

## Testing

Permanent tests must cover:

- patch/minor/major SemVer increments and invalid inputs;
- Conventional Commits suggestion precedence;
- canonical version-source updates and generated notes;
- latest-tag/package-version mismatch rejection;
- exact-SHA release PR authorization;
- prepare workflow authority boundaries;
- publish workflow CI and exact-SHA boundaries.
