import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkReleaseReadiness } from "../../scripts/release-readiness.mjs";
import { FIELD_TEST_SCENARIOS } from "../../v2/cutover/field-evidence.mjs";

const HEAD = "a".repeat(40);
const RUNTIME_IMAGE = `sha256:${"b".repeat(64)}`;
const REQUIRED_SCRIPTS = [
  "test",
  "test:runtime",
  "test:core",
  "test:direct-work",
  "test:leases",
  "test:labs",
  "test:installers",
  "test:firewall",
  "test:architecture-invariants",
  "check:schemas",
  "check:runtime-core",
  "build:runtimes",
  "check:runtimes",
  "check:contamination",
  "doctor",
];

function fixture({
  version = "1.0.0-rc.0",
  migration = true,
  scripts = true,
  schemaFresh = true,
  runtimesFresh = true,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-release-readiness-"));
  mkdirSync(join(root, "runtime/manifests"), { recursive: true });
  mkdirSync(join(root, "docs/migrations"), { recursive: true });
  mkdirSync(join(root, "docs/release"), { recursive: true });
  mkdirSync(join(root, "core/schema/generated"), { recursive: true });
  mkdirSync(join(root, "schemas"), { recursive: true });
  const packageScripts = Object.fromEntries(REQUIRED_SCRIPTS.map((name) => [name, "node -e \"\""]));
  packageScripts["check:schemas"] = schemaFresh ? "node -e \"\"" : "node -e \"process.exit(23)\"";
  packageScripts["check:runtimes"] = runtimesFresh ? "node -e \"\"" : "node -e \"process.exit(24)\"";
  writeFileSync(join(root, "package.json"), JSON.stringify({ version, ...(scripts ? { scripts: packageScripts } : {}) }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ version, packages: { "": { version } } }));
  writeFileSync(join(root, "core/schema/generated/implementation-packet.v1.mjs"), "export default {};\n");
  writeFileSync(join(root, "schemas/implementation-packet.v1.schema.json"), "{}\n");
  for (const runtime of ["core", "codex", "antigravity"]) {
    writeFileSync(join(root, `runtime/manifests/${runtime}.json`), JSON.stringify({ runtime, version }));
  }
  if (migration) {
    writeFileSync(join(root, "docs/migrations/0.10-to-1.x.md"), [
      "ORCHESTRA_DIRECT_WORK_MODE=off|shadow|on",
      "ORCHESTRA_AUTHORITY_MODE=session|dual|lease",
      "runtime update rollback preserved state",
    ].join("\n"));
  }
  writeFileSync(join(root, "docs/release/1.x-checklist.md"), "RC checklist\nTask 9 — operator approval required\nDo not bump stable version to 1.0.0 without approval.\n");
  return root;
}

function verified(facts = {}) {
  return { status: "VERIFIED", headSha: HEAD, facts };
}

function providerFieldEvidence(provider) {
  return FIELD_TEST_SCENARIOS.map((scenarioId, index) => ({
    schema: "orchestra.cutover-field-evidence.v2",
    version: 1,
    provider: { family: provider, version: provider === "codex" ? "0.162.0" : "3.8.0" },
    project: { lineageId: `lineage-${provider}` },
    runtimeImageId: RUNTIME_IMAGE,
    headSha: HEAD,
    scenarioId,
    factualResult: {
      ok: true,
      code: `FACT_${index + 1}`,
      factRef: `evidence:${provider}:${scenarioId.toLowerCase()}`,
    },
    terminalStatus: "VERIFIED",
    observedAt: "2026-10-18T01:00:00.000Z",
    evidenceRefs: [`sha256:${String(index + 1).padStart(64, "0")}`],
    operatorAttestation: null,
  }));
}

function cutoverEvidence() {
  return {
    schema: "orchestra.cutover-release-evidence.v2",
    version: 1,
    headSha: HEAD,
    runtimeImageId: RUNTIME_IMAGE,
    readiness: {
      registryPersistence: verified(),
      providers: { codex: verified(), antigravity: verified() },
      runtimeLifecycle: verified({
        installed: true,
        pinned: true,
        rollbackVerified: true,
        runtimeImageId: RUNTIME_IMAGE,
      }),
      reconciliation: verified({ staleRecoveryVerified: true, dirtyRecoveryVerified: true }),
      experiencePrivacy: verified(),
      rsiReplay: verified({ trainVerified: true, evaluateVerified: true, holdoutVerified: true }),
      migration: verified({ migrationVerified: true, tsuzukiF7Verified: true }),
      platforms: { windows: verified(), posix: verified() },
      projects: [
        verified({ projectId: "project-a", lineageId: "lineage-a", noFullLocalGovernanceRuntime: true }),
        verified({ projectId: "project-b", lineageId: "lineage-b", noFullLocalGovernanceRuntime: true }),
      ],
      selfHost: verified({
        projectId: "project-orchestra",
        lineageId: "lineage-orchestra",
        runtimeImageId: RUNTIME_IMAGE,
        noFullLocalGovernanceRuntime: true,
      }),
    },
    providerFieldEvidence: {
      codex: providerFieldEvidence("codex"),
      antigravity: providerFieldEvidence("antigravity"),
    },
    ci: {
      headSha: HEAD,
      runId: 39000000000,
      ubuntuV2: true,
      windowsV2: true,
      v1Compatibility: true,
    },
    evidenceRefs: ["github-actions:39000000000"],
  };
}

test("release readiness accepts coherent RC metadata, gates, and rollback documentation", () => {
  const root = fixture();
  try {
    const report = checkReleaseReadiness({ repoRoot: root, expectedVersion: "1.0.0-rc.0" });
    assert.equal(report.ready, true);
    assert.deepEqual(report.failures, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("v2 release readiness consumes exact-head/runtime cutover evidence", () => {
  const root = fixture();
  try {
    const report = checkReleaseReadiness({
      repoRoot: root,
      expectedVersion: "1.0.0-rc.0",
      requireV2Cutover: true,
      cutoverEvidence: cutoverEvidence(),
      expectedHeadSha: HEAD,
      expectedRuntimeImageId: RUNTIME_IMAGE,
    });
    assert.equal(report.ready, true);
    assert.equal(report.checks.find((item) => item.id === "v2:cutover-evidence")?.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("v2 release readiness fails closed without cutover evidence", () => {
  const root = fixture();
  try {
    const report = checkReleaseReadiness({
      repoRoot: root,
      expectedVersion: "1.0.0-rc.0",
      requireV2Cutover: true,
      expectedHeadSha: HEAD,
      expectedRuntimeImageId: RUNTIME_IMAGE,
    });
    assert.equal(report.ready, false);
    assert.ok(report.failures.some((item) => item.id === "v2:cutover-evidence"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("v2 release readiness rejects stale-head field evidence", () => {
  const root = fixture();
  try {
    const evidence = cutoverEvidence();
    evidence.providerFieldEvidence.codex[0].headSha = "f".repeat(40);
    const report = checkReleaseReadiness({
      repoRoot: root,
      expectedVersion: "1.0.0-rc.0",
      requireV2Cutover: true,
      cutoverEvidence: evidence,
      expectedHeadSha: HEAD,
      expectedRuntimeImageId: RUNTIME_IMAGE,
    });
    assert.equal(report.ready, false);
    assert.ok(report.failures.some((item) => item.id === "v2:cutover-evidence"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release readiness fails closed on version drift", () => {
  const root = fixture({ version: "0.10.0" });
  try {
    const report = checkReleaseReadiness({ repoRoot: root, expectedVersion: "1.0.0-rc.0" });
    assert.equal(report.ready, false);
    assert.ok(report.failures.some((item) => item.id === "version:package"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release readiness requires documented rollback levers", () => {
  const root = fixture({ migration: false });
  try {
    const report = checkReleaseReadiness({ repoRoot: root, expectedVersion: "1.0.0-rc.0" });
    assert.equal(report.ready, false);
    assert.ok(report.failures.some((item) => item.id === "docs:migration"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release readiness rejects missing executable release gates", () => {
  const root = fixture({ scripts: false });
  try {
    const report = checkReleaseReadiness({ repoRoot: root, expectedVersion: "1.0.0-rc.0" });
    assert.equal(report.ready, false);
    assert.ok(report.failures.some((item) => item.id === "gates:package-scripts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release readiness rejects stale generated schema validators", () => {
  const root = fixture({ schemaFresh: false });
  try {
    const report = checkReleaseReadiness({ repoRoot: root, expectedVersion: "1.0.0-rc.0" });
    assert.equal(report.ready, false);
    assert.ok(report.failures.some((item) => item.id === "generated:schema-freshness"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release readiness rejects stale manifest-driven runtime distributions", () => {
  const root = fixture({ runtimesFresh: false });
  try {
    const report = checkReleaseReadiness({ repoRoot: root, expectedVersion: "1.0.0-rc.0" });
    assert.equal(report.ready, false);
    assert.ok(report.failures.some((item) => item.id === "generated:runtime-freshness"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
