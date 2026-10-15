import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { bumpVersion, suggestBump } from "../../scripts/release/versioning.mjs";
import { prepareRelease } from "../../scripts/release/prepare-release.mjs";
import { evaluateExistingPublication, validatePublishAuthorization } from "../../scripts/release/publish-guard.mjs";

const CANONICAL_RUNTIMES = Object.freeze(["core", "codex", "antigravity", "delegation"]);

function fixture(version = "1.0.1") {
  const root = mkdtempSync(join(tmpdir(), "orchestra-release-train-"));
  mkdirSync(join(root, "runtime/manifests"), { recursive: true });
  mkdirSync(join(root, "docs/release"), { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "orchestra",
    version,
    scripts: { "release:readiness": `node scripts/release-readiness.mjs --expected-version=${version}` },
  }, null, 2)}\n`);
  writeFileSync(join(root, "package-lock.json"), `${JSON.stringify({
    name: "orchestra",
    version,
    lockfileVersion: 3,
    packages: { "": { name: "orchestra", version } },
  }, null, 2)}\n`);
  for (const runtime of CANONICAL_RUNTIMES) {
    writeFileSync(join(root, `runtime/manifests/${runtime}.json`), `${JSON.stringify({ runtime, version }, null, 2)}\n`);
  }
  return root;
}

test("bumpVersion applies stable semantic-version increments", () => {
  assert.equal(bumpVersion("1.0.1", "patch"), "1.0.2");
  assert.equal(bumpVersion("1.0.1", "minor"), "1.1.0");
  assert.equal(bumpVersion("1.0.1", "major"), "2.0.0");
  assert.throws(() => bumpVersion("1.0.1", "select"), /patch, minor, or major/);
  assert.throws(() => bumpVersion("1.0.1-rc.0", "patch"), /stable semantic version/);
});

test("suggestBump follows conventional-commit significance", () => {
  assert.equal(suggestBump([{ subject: "fix: repair doctor", body: "" }]), "patch");
  assert.equal(suggestBump([{ subject: "feat: add delegation", body: "" }, { subject: "fix: guard drift", body: "" }]), "minor");
  assert.equal(suggestBump([{ subject: "feat!: replace public contract", body: "" }]), "major");
  assert.equal(suggestBump([{ subject: "feat: evolve contract", body: "BREAKING CHANGE: old input removed" }]), "major");
  assert.equal(suggestBump([{ subject: "docs: clarify release", body: "" }]), null);
});

test("prepareRelease updates canonical version sources and writes reviewable notes", () => {
  const root = fixture();
  try {
    const result = prepareRelease({
      repoRoot: root,
      bump: "minor",
      baseTag: "v1.0.1",
      commits: [
        { sha: "abcdef1234567890", subject: "feat: add provider-neutral release train", body: "" },
        { sha: "1234567890abcdef", subject: "fix: fail closed on stale release tag", body: "" },
      ],
      generatedAt: "2026-10-14T18:00:00.000Z",
    });

    assert.equal(result.currentVersion, "1.0.1");
    assert.equal(result.version, "1.1.0");
    assert.equal(result.tag, "v1.1.0");
    assert.equal(result.suggestedBump, "minor");

    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    assert.equal(pkg.version, "1.1.0");
    assert.equal(pkg.scripts["release:readiness"], "node scripts/release-readiness.mjs");
    assert.equal(lock.version, "1.1.0");
    assert.equal(lock.packages[""].version, "1.1.0");
    for (const runtime of CANONICAL_RUNTIMES) {
      assert.equal(JSON.parse(readFileSync(join(root, `runtime/manifests/${runtime}.json`), "utf8")).version, "1.1.0");
    }

    const notes = readFileSync(join(root, "docs/release/v1.1.0.md"), "utf8");
    assert.match(notes, /# Orchestra v1\.1\.0/);
    assert.match(notes, /Base tag: `v1\.0\.1`/);
    assert.match(notes, /Requested bump: `minor`/);
    assert.match(notes, /Suggested bump: `minor`/);
    assert.match(notes, /## Features/);
    assert.match(notes, /provider-neutral release train/);
    assert.match(notes, /## Fixes/);
    assert.match(notes, /stale release tag/);
    assert.match(notes, /exact.*main.*SHA/i);
    assert.match(notes, /Create a merge commit/);
    assert.match(notes, /Squash and rebase merges fail closed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareRelease fails closed when the base tag and package version disagree", () => {
  const root = fixture("1.0.1");
  try {
    assert.throws(() => prepareRelease({
      repoRoot: root,
      bump: "minor",
      baseTag: "v1.0.0",
      commits: [],
      generatedAt: "2026-10-14T18:00:00.000Z",
    }), /base tag.*package version/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing published versions no-op on later main commits while partial conflicting state fails closed", () => {
  assert.deepEqual(evaluateExistingPublication({
    sha: "new-main-sha",
    tagSha: "older-release-sha",
    releaseExists: true,
    releaseSha: "older-release-sha",
  }), { action: "noop", tagExists: true, releaseExists: true, reason: "already-published" });

  const missingReleaseProvenance = evaluateExistingPublication({
    sha: "new-main-sha",
    tagSha: "older-release-sha",
    releaseExists: true,
  });
  assert.equal(missingReleaseProvenance.action, "fail");
  assert.match(missingReleaseProvenance.reason, /release integration SHA/i);

  const partialConflict = evaluateExistingPublication({
    sha: "new-main-sha", tagSha: "older-release-sha", releaseExists: false,
  });
  assert.equal(partialConflict.action, "fail");
  assert.match(partialConflict.reason, /different SHA/);

  assert.deepEqual(evaluateExistingPublication({
    sha: "release-sha", tagSha: "release-sha", releaseExists: false,
  }), { action: "publish", tagExists: true, releaseExists: false });
});

test("publish guard accepts only a successful exact-main release PR association", () => {
  const authorized = validatePublishAuthorization({
    version: "1.1.0",
    sha: "deadbeef",
    ciConclusion: "success",
    parentCount: 2,
    pullRequests: [{
      merged_at: "2026-10-14T19:00:00Z",
      merge_commit_sha: "deadbeef",
      base: { ref: "main" },
      head: { ref: "release/v1.1.0" },
    }],
  });
  assert.equal(authorized.ok, true);
  assert.equal(authorized.tag, "v1.1.0");

  assert.equal(validatePublishAuthorization({
    version: "1.1.0", sha: "deadbeef", ciConclusion: "failure", parentCount: 2, pullRequests: [],
  }).ok, false);
  assert.equal(validatePublishAuthorization({
    version: "1.1.0",
    sha: "deadbeef",
    ciConclusion: "success",
    parentCount: 2,
    pullRequests: [{ merged_at: "x", merge_commit_sha: "deadbeef", base: { ref: "main" }, head: { ref: "feat/not-release" } }],
  }).ok, false);
  assert.equal(validatePublishAuthorization({
    version: "1.1.0",
    sha: "deadbeef",
    ciConclusion: "success",
    parentCount: 2,
    pullRequests: [{ merged_at: "x", merge_commit_sha: "cafebabe", base: { ref: "main" }, head: { ref: "release/v1.1.0" } }],
  }).ok, false);
});

test("prepare workflow requires an operator bump, full preflight, and clean PR-creation failure", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const workflow = readFileSync(join(root, ".github/workflows/prepare-release.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /select[\s\S]*patch[\s\S]*minor[\s\S]*major/);
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /pull-requests:\s*write/);
  assert.match(workflow, /scripts\/release\/prepare-release\.mjs/);
  assert.match(workflow, /npm run build:runtimes/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run doctor/);
  assert.match(workflow, /npm run check:contamination/);
  assert.match(workflow, /npm run release:readiness/);
  assert.match(workflow, /release\/\$\{TAG\}/);
  assert.match(workflow, /gh pr create/);
  assert.match(workflow, /if ! gh pr create[\s\S]*git push origin --delete/);
  assert.match(workflow, /Create a merge commit/);
  assert.doesNotMatch(workflow, /gh release create/);
});

test("publish workflow waits for successful main CI and verifies the exact SHA release PR before publishing", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const workflow = readFileSync(join(root, ".github/workflows/publish-release.yml"), "utf8");
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows:\s*\[\s*"CI"\s*\]/);
  assert.match(workflow, /conclusion == 'success'/);
  assert.match(workflow, /head_branch == 'main'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_sha/);
  assert.match(workflow, /commits\/\$\{SHA\}\/pulls/);
  assert.match(workflow, /git rev-list --parents/);
  assert.match(workflow, /--parent-count/);
  assert.match(workflow, /publish-guard\.mjs/);
  assert.match(workflow, /git tag -a/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /release_exists/);
  assert.match(workflow, /tag_exists/);
});
