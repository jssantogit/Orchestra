import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

const pairs = [
  {
    name: "evidence federation",
    codex: "runtimes/codex/.codex/astra-orchestra/evidence-federation.mjs",
    antigravity: "runtimes/antigravity/.agents/skills/orchestra/evidence-federation.mjs",
    canonical: "core/evidence/evidence-federation.mjs",
  },
  {
    name: "evidence watch",
    codex: "runtimes/codex/.codex/astra-orchestra/evidence-watch.mjs",
    antigravity: "runtimes/antigravity/.agents/skills/orchestra/evidence-watch.mjs",
    canonical: "core/evidence/evidence-watch.mjs",
  },
  {
    name: "feedback plane",
    codex: "runtimes/codex/.codex/astra-orchestra/feedback-plane.mjs",
    antigravity: "runtimes/antigravity/.agents/skills/orchestra/feedback-plane.mjs",
    canonical: "core/feedback/feedback-plane.mjs",
  },
];

async function importRepo(path) {
  return import(pathToFileURL(resolve(root, path)).href + `?parity=${Date.now()}-${Math.random()}`);
}

test("provider-local neutral modules are byte-identical before/after extraction", async () => {
  for (const pair of pairs) {
    const [codex, antigravity] = await Promise.all([
      readFile(resolve(root, pair.codex), "utf8"),
      readFile(resolve(root, pair.antigravity), "utf8"),
    ]);
    assert.equal(codex, antigravity, `${pair.name} provider compatibility files must remain identical`);
  }
});

test("canonical modules expose exactly the same public exports as provider compatibility paths", async () => {
  for (const pair of pairs) {
    const [canonical, codex, antigravity] = await Promise.all([
      importRepo(pair.canonical),
      importRepo(pair.codex),
      importRepo(pair.antigravity),
    ]);
    assert.deepEqual(Object.keys(codex).sort(), Object.keys(canonical).sort(), `${pair.name} Codex exports`);
    assert.deepEqual(Object.keys(antigravity).sort(), Object.keys(canonical).sort(), `${pair.name} Antigravity exports`);
  }
});

test("representative evidence-watch behavior is preserved", async () => {
  const canonical = await importRepo("core/evidence/evidence-watch.mjs");
  const provider = await importRepo("runtimes/codex/.codex/astra-orchestra/evidence-watch.mjs");
  const requirement = { id: "ci", provider: "github", watchPolicy: { initialBackoffMs: 1000, maxBackoffMs: 2000, timeoutMs: 5000 } };
  const stateA = { taskId: "t", attempt: 1, mutationSeq: 2 };
  const stateB = structuredClone(stateA);
  assert.deepEqual(canonical.ensureEvidenceWatch(stateA, requirement, 1000), provider.ensureEvidenceWatch(stateB, requirement, 1000));
  assert.deepEqual(canonical.noteEvidenceWatchResult(stateA, requirement, { result: "PENDING" }, 2000), provider.noteEvidenceWatchResult(stateB, requirement, { result: "PENDING" }, 2000));
});

test("representative feedback hashing and evidence federation behavior is preserved", async () => {
  const [feedbackCore, feedbackProvider, federationCore, federationProvider] = await Promise.all([
    importRepo("core/feedback/feedback-plane.mjs"),
    importRepo("runtimes/codex/.codex/astra-orchestra/feedback-plane.mjs"),
    importRepo("core/evidence/evidence-federation.mjs"),
    importRepo("runtimes/codex/.codex/astra-orchestra/evidence-federation.mjs"),
  ]);

  assert.equal(feedbackCore.feedbackHash({ b: 2, a: 1 }), feedbackProvider.feedbackHash({ a: 1, b: 2 }));

  const coreState = { evidenceLedger: [] };
  const providerState = { evidenceLedger: [] };
  const evidence = { evidenceId: "e1", result: "PASS" };
  assert.deepEqual(federationCore.mergeFederatedEvidence(coreState, evidence), federationProvider.mergeFederatedEvidence(providerState, evidence));
  assert.deepEqual(coreState, providerState);
});
