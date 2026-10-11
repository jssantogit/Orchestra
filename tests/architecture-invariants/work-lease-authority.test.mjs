import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (path) => readFileSync(resolve(root, path), "utf8");

const canonicalLeasePaths = [
  "acceptance/direct-work.mjs",
  "leases/atomic-lock.mjs",
  "leases/lease-authorizer.mjs",
  "leases/work-continuation.mjs",
  "leases/work-lease-store.mjs",
  "leases/workspace-fingerprint.mjs",
];

test("provider-neutral Work Lease core contains no provider authority vocabulary", () => {
  const source = canonicalLeasePaths
    .filter((path) => path.startsWith("leases/"))
    .map((path) => read(`core/${path}`))
    .join("\n");
  assert.doesNotMatch(source, /\bcodex\b|\bantigravity\b|conversationId|mainConversationId|session_id|main_session_id/i);
  assert.match(source, /STALE_WORK_LEASE/);
  assert.match(source, /WORKSPACE_EDIT/);
});

test("session identity is persisted as hashed provenance while generation is the mutation fence", () => {
  const codex = read("runtimes/codex/.codex/astra-orchestra/work-lease-authority.mjs");
  const antigravity = read("runtimes/antigravity/.agents/skills/orchestra/work-lease-authority.mjs");
  for (const source of [codex, antigravity]) {
    assert.match(source, /sessionIdHash/);
    assert.match(source, /STALE_WORK_LEASE/);
    assert.match(source, /generation/);
    assert.match(source, /WORKSPACE_EDIT/);
    assert.match(source, /return "lease"/);
    assert.match(source, /return VALID_MODES\.has\(normalized\) \? normalized : "session"/);
  }
  assert.match(codex, /work-lease-session-bindings\.json/);
  assert.match(antigravity, /work-lease-conversation-bindings\.json/);
});

test("providers consume the same neutral Work Lease core without importing one another", () => {
  const codex = read("runtimes/codex/.codex/astra-orchestra/work-lease-authority.mjs");
  const antigravity = read("runtimes/antigravity/.agents/skills/orchestra/work-lease-authority.mjs");
  assert.match(codex, /\.\/core\/leases\/work-lease-store\.mjs/);
  assert.match(codex, /\.\/core\/leases\/lease-authorizer\.mjs/);
  assert.match(antigravity, /\.\/core\/leases\/work-lease-store\.mjs/);
  assert.match(antigravity, /\.\/core\/leases\/lease-authorizer\.mjs/);
  assert.doesNotMatch(codex, /runtimes\/antigravity|\.agents\/skills/);
  assert.doesNotMatch(antigravity, /runtimes\/codex|\.codex\/astra-orchestra/);
});

test("runtime-core mirrors are byte-identical for Work Lease modules", () => {
  for (const path of canonicalLeasePaths) {
    const canonical = read(`core/${path}`);
    const codex = read(`runtimes/codex/.codex/astra-orchestra/core/${path}`);
    const antigravity = read(`runtimes/antigravity/.agents/skills/orchestra/core/${path}`);
    assert.equal(codex, canonical, `Codex runtime-core drift: ${path}`);
    assert.equal(antigravity, canonical, `Antigravity runtime-core drift: ${path}`);
  }
});

test("Antigravity Work Lease wraps root hooks while delegated child governance stays legacy", () => {
  const hooks = JSON.parse(read("runtimes/antigravity/.agents/hooks.json"));
  const preInvocationCommand = hooks["guard-rails"].PreInvocation[0].command;
  const preToolCommand = hooks["scope-enforcer"].PreToolUse[0].hooks[0].command;
  assert.equal(preInvocationCommand, "node hooks/work-lease-pre-invocation.mjs");
  assert.equal(preToolCommand, "node hooks/work-lease-pre-tool.mjs");

  const preInvocation = read("runtimes/antigravity/.agents/hooks/work-lease-pre-invocation.mjs");
  const preTool = read("runtimes/antigravity/.agents/hooks/work-lease-pre-tool.mjs");
  assert.match(preInvocation, /pre-invocation-guard\.mjs/);
  assert.match(preTool, /pre-tool-enforce\.mjs/);
  assert.match(preInvocation, /LEASE_ROOT_REQUIRED|rootCandidate/);
  assert.match(preTool, /if \(!rootLike\)[\s\S]*delegate\(rawInput\)/);
});

test("neutral state is locally ignored and cannot be deleted by managed runtime replacement", () => {
  const ignore = read("runtime/project-state-ignore.mjs");
  assert.match(ignore, /\.orchestra\/state\/\*\*/);
  assert.doesNotMatch(ignore, /\.gitignore/);

  const codexManager = read("runtimes/codex/.codex/astra-orchestra/codex-runtime-manager.mjs");
  assert.match(codexManager, /"\.orchestra\/state"/);
  assert.match(codexManager, /ensureProjectStateIgnored/);

  const agyManager = read("runtimes/antigravity/.agents/skills/orchestra/project-runtime-manager.mjs");
  const managedBlock = agyManager.match(/MANAGED_RUNTIME_PATHS = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1] || "";
  assert.doesNotMatch(managedBlock, /\.orchestra\/state/);
  const agyAuthority = read("runtimes/antigravity/.agents/skills/orchestra/work-lease-authority.mjs");
  assert.match(agyAuthority, /ensureProjectStateIgnored\(repoRoot\)/);
});
