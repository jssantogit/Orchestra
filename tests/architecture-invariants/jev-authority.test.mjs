import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { projectForJev } from "../../experiments/jev/outbound-projector.mjs";
import { buildRetrievalAssistedPacket } from "../../experiments/jev/retrieval-assist.mjs";
import { JEV_AUTHORITY, JEV_SCHEMAS } from "../../experiments/jev/schemas.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (path) => readFileSync(resolve(root, path), "utf8");

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

test("ARCH-L01: Jev authority is permanently NONE", () => {
  assert.equal(JEV_AUTHORITY, "NONE");
  const source = walk(resolve(root, "experiments/jev"))
    .filter((path) => path.endsWith(".mjs"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  assert.equal(/authority\s*[:=]\s*["'](?:RUNTIME_AUTHORITY|EVIDENCE|ACCEPTANCE|ROUTING)["']/i.test(source), false);
});

test("ARCH-L02: active Codex/Antigravity operational code cannot import or route Jev", () => {
  const active = [
    "runtimes/codex/.codex/astra-orchestra/routing-policy.mjs",
    "runtimes/codex/.codex/config.toml",
    "runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs",
    "runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs",
    "runtimes/antigravity/.agents/hooks/pre-tool-side-effect-guard.mjs",
    "runtimes/antigravity/.agents/hooks/pre-invocation-guard.mjs",
    "runtimes/antigravity/.agents/hooks/post-tool-telemetry.mjs",
    "runtimes/antigravity/.agents/hooks/stop-guard.mjs",
  ];
  for (const rel of active) {
    const content = read(rel);
    assert.equal(/experiments[\\/]jev|jev-latest|api\.typesafe\.ai|TYPESAFE_API_KEY/i.test(content), false, rel);
    assert.equal(/(?:model|worker|reviewer|executor|profile)\s*[:=][^\n]*(?:jev|typesafe)/i.test(content), false, rel);
  }
});

test("ARCH-L03: Jev client boundary is projection-only and raw transcript pruning is absent", () => {
  const client = read("experiments/jev/client.mjs");
  const projector = read("experiments/jev/outbound-projector.mjs");
  const sourceFiles = walk(resolve(root, "experiments/jev"))
    .filter((path) => path.endsWith(".mjs"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");

  assert.match(client, /validateProjection\(projection\)/);
  assert.match(client, /JEV_PROJECTION_ONLY/);
  assert.match(projector, /JEV_EGRESS_FORBIDDEN_FIELD/);
  assert.equal(/drop_call|drop_result|compactMessages|session\.compact|transcript\.splice|messages\.splice/i.test(sourceFiles), false);
});

test("ARCH-L04: outbound projection rejects transcript/provider-reasoning fields", () => {
  const base = {
    schema: JEV_SCHEMAS.CANDIDATE,
    id: "c",
    authority: "NONE",
    kind: "ARTIFACT",
    summary: "safe",
    bytes: 0,
  };
  for (const field of ["stdout", "stderr", "content", "transcript", "messages", "prompt", "reasoning", "thinking", "credentials"]) {
    assert.throws(
      () => projectForJev({ goal: "x", candidates: [{ ...base, [field]: "secret" }] }),
      /JEV_EGRESS_FORBIDDEN_FIELD/,
      field,
    );
  }
});

test("ARCH-L05: Retrieval Assist is identity fallback without factual report + human gate + flag", () => {
  const mandatory = {
    goal: "task",
    scopeContract: { allowedPaths: ["src/**"], forbiddenPaths: [".agents/**"] },
    requiredEvidence: ["TEST_RUN"],
  };
  const result = buildRetrievalAssistedPacket({
    projectRoot: root,
    report: null,
    mandatoryCore: mandatory,
    candidates: [],
    ranking: { items: [] },
    env: {},
  });
  assert.equal(result.active, false);
  assert.equal(result.fallback_identity, true);
  assert.equal(result.packet, mandatory);
});

test("ARCH-L06: Dream analyzer writes sidecars and contains no world mutation path", () => {
  const source = read("experiments/jev/dream-analyzer.mjs");
  assert.match(source, /jev-annotations/);
  assert.match(source, /JEV_DREAM_WORLD_MUTATED/);
  assert.equal(/writeFileSync\(worldPath|renameSync\(.*world|unlinkSync\(.*world/i.test(source), false);
});

test("ARCH-L07: Jev never enters Evidence Ledger or acceptance paths", () => {
  const evidence = read("runtimes/antigravity/.agents/skills/orchestra/evidence-contract.mjs");
  const feedback = read("runtimes/antigravity/.agents/skills/orchestra/feedback-plane.mjs");
  const stop = read("runtimes/antigravity/.agents/hooks/stop-guard.mjs");
  for (const content of [evidence, feedback, stop]) {
    assert.equal(/jev|typesafe/i.test(content), false);
  }
});

test("ARCH-L08: redundancy scoring cannot block tools", () => {
  const source = read("experiments/jev/redundancy-shadow.mjs");
  assert.match(source, /blocks_tool:\s*false/);
  assert.equal(/decision:\s*["']deny["']|throw new Error\(["']TOOL_DENIED/i.test(source), false);
});
