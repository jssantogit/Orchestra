import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);

const MODULES = [
  {
    name: "evidence-federation",
    codex: "runtimes/codex/.codex/astra-orchestra/evidence-federation.mjs",
    antigravity: "runtimes/antigravity/.agents/skills/orchestra/evidence-federation.mjs",
    canonical: "core/evidence/evidence-federation.mjs",
  },
  {
    name: "evidence-watch",
    codex: "runtimes/codex/.codex/astra-orchestra/evidence-watch.mjs",
    antigravity: "runtimes/antigravity/.agents/skills/orchestra/evidence-watch.mjs",
    canonical: "core/evidence/evidence-watch.mjs",
  },
  {
    name: "feedback-plane",
    codex: "runtimes/codex/.codex/astra-orchestra/feedback-plane.mjs",
    antigravity: "runtimes/antigravity/.agents/skills/orchestra/feedback-plane.mjs",
    canonical: "core/feedback/feedback-plane.mjs",
  },
];

async function importRepo(path) {
  return import(`${pathToFileURL(resolve(repoRoot, path)).href}?parity=${Date.now()}-${Math.random()}`);
}

test("the three extraction candidates are byte-identical across provider runtimes before extraction", async () => {
  for (const entry of MODULES) {
    const codex = await readFile(resolve(repoRoot, entry.codex));
    const antigravity = await readFile(resolve(repoRoot, entry.antigravity));
    assert.deepEqual(codex, antigravity, `${entry.name} must be byte-identical before neutral extraction`);
  }
});

test("canonical neutral modules preserve the exact provider export surface", async () => {
  for (const entry of MODULES) {
    const provider = await importRepo(entry.codex);
    const canonical = await importRepo(entry.canonical);
    assert.deepEqual(
      Object.keys(canonical).sort(),
      Object.keys(provider).sort(),
      `${entry.name} exports changed during extraction`,
    );
  }
});

test("canonical evidence federation preserves representative ledger behavior", async () => {
  const provider = await importRepo(MODULES[0].codex);
  const canonical = await importRepo(MODULES[0].canonical);
  const evidence = { evidenceId: "ev-1", status: "PASSED" };
  const providerState = { evidenceLedger: [] };
  const canonicalState = { evidenceLedger: [] };

  assert.deepEqual(
    canonical.mergeFederatedEvidence(canonicalState, { ...evidence }),
    provider.mergeFederatedEvidence(providerState, { ...evidence }),
  );
  assert.deepEqual(canonicalState, providerState);
});

test("canonical evidence watch preserves public policy constants", async () => {
  const provider = await importRepo(MODULES[1].codex);
  const canonical = await importRepo(MODULES[1].canonical);
  assert.equal(canonical.EVIDENCE_WATCH_SCHEMA, provider.EVIDENCE_WATCH_SCHEMA);
  assert.deepEqual(canonical.DEFAULT_EVIDENCE_WATCH_POLICY, provider.DEFAULT_EVIDENCE_WATCH_POLICY);
});

test("canonical feedback plane preserves deterministic hashing", async () => {
  const provider = await importRepo(MODULES[2].codex);
  const canonical = await importRepo(MODULES[2].canonical);
  const input = { z: 1, a: { b: 2, a: 3 } };
  assert.equal(canonical.feedbackHash(input), provider.feedbackHash(input));
  assert.equal(canonical.FEEDBACK_SCHEMA, provider.FEEDBACK_SCHEMA);
});
