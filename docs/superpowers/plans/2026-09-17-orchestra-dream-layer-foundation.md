# Orchestra Dream Layer Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Milestones A-C of the approved Orchestra Dream Layer specification: deterministic Decision History, sealed factual worlds, Discovery Tree derivation, and zero-model-call Exact Replay, while preserving existing Antigravity routing behavior.

**Architecture:** Add a new AGY-only `.agents/dream/` library that remains subordinate to existing Orchestra governance. The current `routing-policy.mjs` and hooks remain authoritative; Dream records pre-action snapshots and factual decisions, correlates outcomes with existing telemetry/Evidence Ledger, seals replay-eligible worlds, then replays only exact observed branches. Phase 1 is record-only: no learned policy executes, no branch exploration occurs, and any Dream failure falls back to the current static path.

**Tech Stack:** Node.js 18+ ESM, built-in `node:test`, `node:assert/strict`, `node:crypto`, `node:fs`, `node:path`, existing Antigravity lifecycle hooks, existing Orchestra routing/evidence state. No new runtime dependency is required for Milestones A-C.

**Spec:** `docs/superpowers/specs/2026-09-17-orchestra-dream-layer-spec.md`

## Global Constraints

- Implement **only Milestones A-C**. Do not add automatic exploration, policy mutation/design, shadow mode, canary, learned-policy activation, generalized evidence, or automatic promotion.
- Dream v1 is **Antigravity / ALL-GEMINI only**. Codex must not import `.agents/dream/` or read Dream state.
- Existing Orchestra governance always precedes Dream: hooks, state machine, Scope Contracts, Evidence Ledger, retry budgets, Human Gate, Two-Key Review, provider firewall, and acceptance semantics remain authoritative.
- Phase 1 is record-only and must preserve **100% supported routing parity**, **zero new model turns**, and **zero worker/reviewer-selection change**.
- Discovery History must never enter worker context. Raw history must not be injected into orchestrator context.
- Exact Replay requires exact `snapshot_id` equality and must return `UNKNOWN_BRANCH` for unobserved actions.
- Exact Replay must use **zero model calls** and may reveal only recorded observations.
- Dream failure => current static routing + no learning. Governance failure => existing fail-closed behavior.
- Workspace fingerprinting must exclude `.git/`, dependency stores, build outputs/caches, `.agents/state/`, `.agents/telemetry/`, `.agents/artifacts/`, `.agents/dream-data/`, and configured temporary/log paths.
- AGY uncached token counts remain `null` / `NOT_DERIVABLE`; do not subtract cache counters.
- Generated `.agents/dream-data/` is local-only and ignored by Git.
- No task in this plan may weaken existing regression, contamination, hook, routing, installer, or turn-economy tests.

---

## File Structure Locked by This Plan

Create focused Dream modules under `runtimes/antigravity/.agents/dream/`:

```text
runtimes/antigravity/.agents/dream/
  schemas/
    snapshot-v1.schema.json
    decision-v1.schema.json
    outcome-v1.schema.json
    world-v1.schema.json
  canonical.mjs
  snapshot.mjs
  action-space.mjs
  records.mjs
  decision-recorder.mjs
  outcome-recorder.mjs
  world-sealer.mjs
  discovery-tree-builder.mjs
  replay-simulator.mjs
  evaluator.mjs
  dream.test.mjs
```

Transient runtime correlation lives under `.agents/state/dream/`; replay/history data lives under `.agents/dream-data/`. Do not create `policy-engine.mjs` or `static-policy-v1.json` in this plan; those belong to Milestone D.

The existing hooks are modified only as adapters:

- `pre-tool-enforce.mjs`: emit a factual pre-action `DECISION` for supported delegation decisions after existing governance approves the action but before the tool executes.
- `post-tool-telemetry.mjs`: emit `DECISION_OUTCOME` when the corresponding delegated action returns and factual local evidence/state is available.
- `stop-guard.mjs`: optionally finalize terminal trajectory metadata for the latest open Dream decision without changing stop/continue semantics.

---

### Task 1: Canonical Serialization and Versioned Record Schemas

**Files:**
- Create: `runtimes/antigravity/.agents/dream/canonical.mjs`
- Create: `runtimes/antigravity/.agents/dream/records.mjs`
- Create: `runtimes/antigravity/.agents/dream/schemas/snapshot-v1.schema.json`
- Create: `runtimes/antigravity/.agents/dream/schemas/decision-v1.schema.json`
- Create: `runtimes/antigravity/.agents/dream/schemas/outcome-v1.schema.json`
- Create: `runtimes/antigravity/.agents/dream/schemas/world-v1.schema.json`
- Create/Test: `runtimes/antigravity/.agents/dream/dream.test.mjs`

**Interfaces:**
- Produces `canonicalize(value, options?) -> string`.
- Produces `sha256Canonical(value, options?) -> "sha256:<hex>"`.
- Produces `createDreamEvent(type, fields) -> event` with `event_hash`.
- Produces `validateDreamRecord(kind, value) -> { valid, errors }`.
- Later tasks rely on schema names `orchestra.snapshot.v1`, `orchestra.decision.v1`, `orchestra.outcome.v1`, and `orchestra.world.v1`.

- [ ] **Step 1: Write failing canonicalization tests**

Add tests proving object key order does not change serialization, set-like arrays can be explicitly sorted, ordinary arrays remain order-sensitive, non-finite numbers and `undefined` are rejected, and event hash excludes `event_hash` itself.

```js
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalize, sha256Canonical } from "./canonical.mjs";

test("dream canonicalization sorts object keys but preserves ordered arrays", () => {
  assert.equal(canonicalize({ b: 2, a: 1 }), canonicalize({ a: 1, b: 2 }));
  assert.notEqual(canonicalize({ xs: ["a", "b"] }), canonicalize({ xs: ["b", "a"] }));
});

test("dream canonicalization sorts only schema-declared set arrays", () => {
  const a = { allowedPaths: ["b/**", "a/**"] };
  const b = { allowedPaths: ["a/**", "b/**"] };
  assert.equal(
    canonicalize(a, { setLikeKeys: new Set(["allowedPaths"]) }),
    canonicalize(b, { setLikeKeys: new Set(["allowedPaths"]) }),
  );
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test runtimes/antigravity/.agents/dream/dream.test.mjs
```

Expected: module-not-found or missing-export failure for `canonical.mjs`.

- [ ] **Step 3: Implement canonicalization without dependencies**

Implement recursive canonical JSON serialization with these exact rules: UTF-8 strings; lexicographically sorted object keys; array order preserved by default; arrays under keys explicitly listed in `setLikeKeys` sorted by their canonical element representation; `/` path normalization is not global and stays in `snapshot.mjs`; reject `undefined`, functions, symbols, bigint, NaN, and infinities.

Export:

```js
export function canonicalize(value, { setLikeKeys = new Set() } = {}) { /* deterministic */ }
export function sha256Canonical(value, options = {}) { /* sha256:<hex> */ }
```

- [ ] **Step 4: Add minimal structural record validation**

Do not add Ajv or another dependency in this milestone. JSON schema files are the portable contract; `records.mjs` performs deterministic required-field/type/enum checks used at runtime.

```js
export const DREAM_SCHEMAS = Object.freeze({
  SNAPSHOT: "orchestra.snapshot.v1",
  DECISION: "orchestra.decision.v1",
  OUTCOME: "orchestra.outcome.v1",
  WORLD: "orchestra.world.v1",
});

export function createDreamEvent(type, fields) {
  const base = { ...fields, type };
  return { ...base, event_hash: sha256Canonical(base) };
}
```

Schemas must reject extra authority fields such as `override_governance`, `retry_budget_override`, `provider`, or `active_policy` in Phase 1 records.

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test runtimes/antigravity/.agents/dream/dream.test.mjs
```

Expected: PASS for canonicalization, hashing, and schema-shape tests.

- [ ] **Step 6: Commit**

```bash
git add runtimes/antigravity/.agents/dream
git commit -m "feat(dream): add canonical records and schemas"
```

---

### Task 2: Snapshot Builder and Conservative Workspace Fingerprinting

**Files:**
- Create: `runtimes/antigravity/.agents/dream/snapshot.mjs`
- Modify/Test: `runtimes/antigravity/.agents/dream/dream.test.mjs`

**Interfaces:**
- Consumes `canonicalize()` and `sha256Canonical()` from Task 1.
- Produces `buildSnapshot(input) -> { ok, snapshot?, reason? }`.
- Produces `buildWorkspaceManifest(repoRoot, options?)`.
- Produces `normalizeTaskSpec(text)` and explicit component fingerprint helpers.

- [ ] **Step 1: Add failing snapshot tests in a temporary fixture workspace**

Tests must prove:

```js
const first = buildSnapshot(baseInput);
const second = buildSnapshot(baseInput);
assert.equal(first.snapshot.snapshot_id, second.snapshot.snapshot_id);
```

Also prove file-content changes, executable-bit changes, task-spec changes, contract changes, retry/evidence-state changes, and runtime-fingerprint changes alter `snapshot_id`; changes only inside `.agents/telemetry/`, `.agents/state/`, `.agents/dream-data/`, `node_modules/`, `dist/`, or `.git/` do not.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
node --test runtimes/antigravity/.agents/dream/dream.test.mjs
```

Expected: missing `snapshot.mjs` exports.

- [ ] **Step 3: Implement workspace manifest walking**

Use `lstatSync`/`readdirSync` and streaming `createReadStream` + `createHash("sha256")` for file content. Manifest entry:

```js
{
  path: "src/parser.js",
  type: "file",
  executable: false,
  size: 1234,
  content_hash: "sha256:..."
}
```

Internal symlinks store normalized target text; symlinks resolving outside `repoRoot` return `{ ok:false, reason:"EXTERNAL_SYMLINK_UNSAFE" }` unless explicitly allowlisted through immutable builder options supplied by governance.

- [ ] **Step 4: Implement component fingerprints and snapshot identity**

Use these exact component keys:

```js
{
  schema: "orchestra.snapshot.v1",
  task_fingerprint,
  contract_fingerprint,
  runtime_fingerprint,
  workspace_fingerprint,
  environment_fingerprint,
  execution_state_identity,
  evidence_fingerprint
}
```

`task_fingerprint` normalizes only CRLF/LF and trailing whitespace. `contract_fingerprint` treats `allowedPaths`, `forbiddenPaths`, `doNotChange`, and declaratively set-like criteria lists as sets. `environment_fingerprint` stores names + hashed values only for an explicit allowlist.

- [ ] **Step 5: Add a metadata cache that cannot change correctness**

Cache file hashes in `.agents/state/dream/workspace-hash-cache.json`, keyed by relative path plus `size`, `mtimeMs`, mode, and inode when available. Cache is performance-only: cache read failure or corruption triggers rehash, never snapshot failure. `.agents/state/dream/` itself is excluded from the workspace manifest.

- [ ] **Step 6: Add performance guard test**

Create a representative temporary workspace of at least 500 small files, run two consecutive snapshots, assert identical IDs, and record elapsed time. The second run must exercise cache reuse. Do not make CI flaky with a strict wall-clock assertion; expose `duration_ms` and verify cache hit count. Phase-gate wall-clock target is checked manually/live later.

- [ ] **Step 7: Run tests and commit**

```bash
node --test runtimes/antigravity/.agents/dream/dream.test.mjs
git add runtimes/antigravity/.agents/dream
git commit -m "feat(dream): add deterministic snapshot builder"
```

---

### Task 3: Governance-Derived Action Space and Policy-Visible Decision State

**Files:**
- Create: `runtimes/antigravity/.agents/dream/action-space.mjs`
- Modify: `runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs`
- Modify: `runtimes/antigravity/.agents/skills/orchestra/routing-policy.test.mjs`
- Modify/Test: `runtimes/antigravity/.agents/dream/dream.test.mjs`

**Interfaces:**
- Produces `deriveDecisionState(facts, activeState, evidenceSummary) -> object`.
- Produces `deriveAvailableActions(decisionType, state) -> string[]`.
- Produces `classifyBaselineDecision(facts, route) -> { decisionType, chosenAction } | null`.
- Existing `decideRoute(facts)` remains behaviorally unchanged.

- [ ] **Step 1: Add failing action-space tests**

Cover the approved tables exactly:

```js
assert.deepEqual(
  deriveAvailableActions("WORKER_TIER", { task_action:"IMPLEMENT", complexity:"NORMAL", criticality:"NORMAL" }),
  ["FLASH_MEDIUM", "FLASH_HIGH"],
);
assert.deepEqual(
  deriveAvailableActions("WORKER_TIER", { task_action:"IMPLEMENT", complexity:"DIFFICULT", criticality:"NORMAL" }),
  ["FLASH_HIGH"],
);
assert.deepEqual(
  deriveAvailableActions("RETRY_ACTION", { retry_reason:"MISSING_CONTEXT", criticality:"NORMAL" }),
  ["INVESTIGATE_FIRST", "REPLAN"],
);
assert.deepEqual(deriveAvailableActions("WORKER_TIER", { criticality:"CRITICAL" }), []);
```

Direct Action and critical review must return no Dream action space.

- [ ] **Step 2: Export only the routing normalizers Dream needs**

If required, export existing pure helpers such as implementation complexity normalization instead of duplicating their semantics. Do not move routing logic into Dream and do not make routing import Dream.

The dependency direction must remain:

```text
Dream adapter -> routing pure helpers
routing core -X-> Dream
```

- [ ] **Step 3: Implement deterministic action mapping**

Map actual route profiles/models to Phase-1 actions:

```js
flash-low-worker / WORKER_LOW       -> FLASH_LOW
flash-medium-worker / WORKER_MEDIUM -> FLASH_MEDIUM
flash-worker / WORKER_HIGH          -> FLASH_HIGH
```

For investigation strategy, only emit a decision when the runtime is at a genuine pre-first-mutation implementation-vs-investigate choice. Do not synthesize an `INVESTIGATION_STRATEGY` decision after a task was already classified `INVESTIGATE`.

For retry action, derive only from explicit existing retry reason/budget state. Unknown retry reason => no Dream decision, not guessed classification.

- [ ] **Step 4: Add supported routing parity fixture table**

In `routing-policy.test.mjs`, define a fixture array covering simple/docs/mechanical, normal, difficult, experimental/post-investigation, testing, integration, investigation, retry reasons, Direct Action, CRITICAL review, and unknown/default orchestration. Capture current `decideRoute()` results and assert Dream classification never changes them.

- [ ] **Step 5: Run both suites and commit**

```bash
node --test runtimes/antigravity/.agents/skills/orchestra/routing-policy.test.mjs
node --test runtimes/antigravity/.agents/dream/dream.test.mjs
git add runtimes/antigravity/.agents/dream runtimes/antigravity/.agents/skills/orchestra
git commit -m "feat(dream): derive factual action spaces without changing routing"
```

---

### Task 4: Decision and Outcome Recorders with Fail-Open Telemetry Semantics

**Files:**
- Create: `runtimes/antigravity/.agents/dream/decision-recorder.mjs`
- Create: `runtimes/antigravity/.agents/dream/outcome-recorder.mjs`
- Modify/Test: `runtimes/antigravity/.agents/dream/dream.test.mjs`

**Interfaces:**
- Produces `recordDecision({ repoRoot, telemetryPath, pendingDir, snapshot, decision })`.
- Produces `recordDecisionOutcome({ repoRoot, telemetryPath, pendingDir, correlation, outcome })`.
- Produces `dreamCorrelationKey({ conversationId, stepIdx, toolCallId, branchOrdinal })`.
- Writes pending correlation only under `.agents/state/dream/pending-decisions/`.

- [ ] **Step 1: Add RED tests for decision-before-outcome and idempotency**

Test order in a temporary `events.jsonl`:

```js
assert.equal(events[0].type, "DECISION");
assert.equal(events[1].type, "DECISION_OUTCOME");
assert.equal(events[1].decision_id, events[0].decision_id);
assert.equal(events[0].event_hash.startsWith("sha256:"), true);
```

Calling outcome recording twice for the same correlation must not create two factual outcomes; the second call returns `{ recorded:false, reason:"OUTCOME_ALREADY_RECORDED" }`.

- [ ] **Step 2: Implement correlation files atomically**

Pending record must include only compact factual metadata:

```js
{
  decision_id,
  snapshot_id,
  decision_type,
  chosen_action,
  conversation_id,
  step_idx,
  tool_call_id,
  created_at
}
```

Write via temp file + rename where practical. Correlation failure marks learning invalid but must not affect the primary tool result.

- [ ] **Step 3: Implement fail-open event append**

Recorder functions catch I/O/schema errors and return diagnostics rather than throw into the primary runtime:

```js
{ recorded:false, reason:"DREAM_TELEMETRY_WRITE_FAILED", error_code:"EACCES" }
```

Do not swallow the diagnostic internally; callers may store a compact `dreamRecordingError` in state, but execution continues.

- [ ] **Step 4: Implement outcome facts without subjective quality fields**

Outcome contains local factual result, evidence summary, mutation sequence, retry state, tool/model counters available at that point, evidence execution IDs, and terminal state only when actually known. Missing data is `null`/`UNKNOWN`, never inferred PASS.

- [ ] **Step 5: Run tests and commit**

```bash
node --test runtimes/antigravity/.agents/dream/dream.test.mjs
git add runtimes/antigravity/.agents/dream
git commit -m "feat(dream): record factual decisions and outcomes"
```

---

### Task 5: Record-Only Hook Integration Without Routing Authority

**Files:**
- Modify: `runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs`
- Modify: `runtimes/antigravity/.agents/hooks/post-tool-telemetry.mjs`
- Modify: `runtimes/antigravity/.agents/hooks/hooks.test.mjs`
- Modify: `runtimes/antigravity/.agents/hooks/stop-guard.mjs` only if terminal outcome finalization cannot be derived later by the world sealer; prefer no Stop-hook behavior change.

**Interfaces:**
- PreToolUse adapter calls existing governance first, then `buildSnapshot`, action-space derivation, baseline decision classification, and `recordDecision` immediately before an allowed `invoke_subagent` returns to the engine.
- PostToolUse adapter closes the matching local outcome after `invoke_subagent`/completion telemetry is factual.
- Hook output JSON must remain byte-compatible in semantic fields (`decision`, `overwrite`, `reason`) with current behavior.

- [ ] **Step 1: Add hook regression tests before changing hooks**

Add a test invoking the current allowed `invoke_subagent` fixture and capture:

```js
const before = JSON.parse(execFileSync("node", [preToolScript], { input }));
assert.equal(before.decision, "allow");
```

After Dream integration the same assertion must remain true and no new `overwrite` field may appear unless one already existed for that fixture.

- [ ] **Step 2: Add failing test requiring a pre-action `DECISION`**

Prepare `active-state.json`, `active-contract.json`, and a small temporary product file. Call PreToolUse with an orchestrator `invoke_subagent` selecting `flash-medium-worker`. Assert the allowed response is unchanged and the telemetry stream contains exactly one `DECISION` whose `chosen_action` is `FLASH_MEDIUM`, whose `policy_source` is `STATIC_ROUTING_CURRENT`, and whose snapshot was taken before any worker mutation.

- [ ] **Step 3: Integrate Dream after existing deny checks**

Do not call Dream before hierarchy, Direct Action, agent-profile, scope, or other governance checks. The adapter belongs only in the `invoke_subagent` allow path after the existing contract/bookkeeping inputs are known and before the final `allow` response.

If snapshot building/recording fails:

```js
activeState.dreamRecordingError = "<stable-code>";
// preserve existing allow/deny result
```

Do not retry the Dream operation through the model.

- [ ] **Step 4: Correlate PostToolUse with the pending decision**

When PostToolUse observes the matching invocation/completion, append a `DECISION_OUTCOME` using the pending correlation. Include factual actor identity, `mutationSeq`, Evidence Ledger execution IDs currently available, retry counters, and tool/model counters. Delete/mark-consumed the pending correlation only after outcome append succeeds.

- [ ] **Step 5: Prove Direct Action, reviewers, and CRITICAL paths remain outside learned decisions**

Tests must assert no `DECISION` is recorded for a Direct Action subagent denial, Two-Key reviewer pair, or CRITICAL review route. Existing Two-Key telemetry continues untouched.

- [ ] **Step 6: Prove Dream telemetry failure cannot fail the primary task**

Make the telemetry destination intentionally unwritable/unavailable in a fixture. The hook must return the same allow result and persist a diagnostic where possible. Do not weaken any governance denial in this test.

- [ ] **Step 7: Run hook/routing tests and commit**

```bash
node --test --test-concurrency=1 runtimes/antigravity/.agents/hooks/hooks.test.mjs
node --test runtimes/antigravity/.agents/skills/orchestra/routing-policy.test.mjs
node --test runtimes/antigravity/.agents/dream/dream.test.mjs
git add runtimes/antigravity/.agents/hooks runtimes/antigravity/.agents/dream
git commit -m "feat(dream): instrument record-only delegation decisions"
```

---

### Task 6: World Sealing and Replay Eligibility

**Files:**
- Create: `runtimes/antigravity/.agents/dream/world-sealer.mjs`
- Modify/Test: `runtimes/antigravity/.agents/dream/dream.test.mjs`

**Interfaces:**
- Produces `sealWorld({ events, expectedRuntimeFingerprint? }) -> { status, world?, errors }`.
- Produces `validateWorld(world) -> { valid, errors }`.
- `status` is one of `SEALED`, `WORLD_INCOMPLETE`, `WORLD_INVALID`.

- [ ] **Step 1: Add RED tests for sealing**

Construct event fixtures for:

1. valid decision + correlated outcome + factual actor => `SEALED`;
2. decision without outcome => `WORLD_INCOMPLETE`;
3. mismatched `decision_id` => `WORLD_INVALID`;
4. tampered `event_hash` => `WORLD_INVALID`;
5. unresolved/LOW actor identity => not replay-eligible;
6. evidence provenance referring to absent execution ID => invalid when evidence is required.

- [ ] **Step 2: Implement deterministic event validation**

Recompute every Dream event hash. Verify schema, exact decision/outcome correlation, snapshot schema, runtime fingerprint consistency, actor identity, and required evidence references. Do not use raw LLM text to decide validity.

- [ ] **Step 3: Implement world manifest hash**

Order relevant event IDs/hashes deterministically by factual causal order (`decision` before its `outcome`, then timestamp/step only as stable tie-break metadata) and produce:

```js
world_manifest_hash = sha256Canonical({
  schema: "orchestra.world.v1",
  root_snapshot_id,
  runtime_fingerprint,
  event_hashes,
});
```

Do not claim this protects against a filesystem attacker; it is corruption/tamper detection only.

- [ ] **Step 4: Persist sealed worlds only under `.agents/dream-data/worlds/`**

The library may expose `writeSealedWorld(repoRoot, world)` but tests must show the world is fully derivable again from the event stream. Invalid/incomplete worlds must not be written to the replay-eligible directory.

- [ ] **Step 5: Run tests and commit**

```bash
node --test runtimes/antigravity/.agents/dream/dream.test.mjs
git add runtimes/antigravity/.agents/dream
git commit -m "feat(dream): seal replay-eligible factual worlds"
```

---

### Task 7: Discovery Tree Derivation with Unknown and Multi-Observation Branches

**Files:**
- Create: `runtimes/antigravity/.agents/dream/discovery-tree-builder.mjs`
- Modify/Test: `runtimes/antigravity/.agents/dream/dream.test.mjs`

**Interfaces:**
- Produces `buildDiscoveryTree(world) -> tree`.
- Tree nodes preserve original lineage; same-snapshot deduplication is index-only, never causal-lineage rewriting.

- [ ] **Step 1: Add RED tests for tree semantics**

Use a sealed fixture where `S0` has legal `[FLASH_MEDIUM, FLASH_HIGH]` but only `FLASH_MEDIUM` was observed. Expected structure must explicitly retain HIGH as unknown:

```js
assert.equal(tree.nodes.S0.actions.FLASH_MEDIUM.status, "OBSERVED_ONCE");
assert.equal(tree.nodes.S0.actions.FLASH_HIGH.status, "UNKNOWN_BRANCH");
```

Add two MEDIUM observations with different outcomes and assert status `AMBIGUOUS_OBSERVED` when terminal acceptance differs.

- [ ] **Step 2: Build tree from records, never from LLM summaries**

Group only by exact `snapshot_id + chosen_action`. Preserve every `observation_id` and `resulting_snapshot_id`. Legal-but-unobserved actions come from the recorded governance-derived `available_actions` of that decision, not from current routing guesses.

- [ ] **Step 3: Define support classification**

Use exact labels:

```text
OBSERVED_ONCE
OBSERVED_MULTIPLE_CONSISTENT
AMBIGUOUS_OBSERVED
UNKNOWN_BRANCH
```

Do not calculate probabilities in Milestones A-C.

- [ ] **Step 4: Run tests and commit**

```bash
node --test runtimes/antigravity/.agents/dream/dream.test.mjs
git add runtimes/antigravity/.agents/dream
git commit -m "feat(dream): derive factual discovery trees"
```

---

### Task 8: Prefix-Only Exact Replay Simulator

**Files:**
- Create: `runtimes/antigravity/.agents/dream/replay-simulator.mjs`
- Modify/Test: `runtimes/antigravity/.agents/dream/dream.test.mjs`

**Interfaces:**
- Produces `replayExact({ world, chooseAction, maxTrajectories = 10000 })`.
- `chooseAction({ decisionType, state, availableActions, prefix }) -> action` is a pure callback for tests and future Milestone-D policy integration.
- Replay statuses follow the spec exactly.

- [ ] **Step 1: Add RED exact-replay tests**

Test a baseline callback that always returns each historical chosen action and expect `EXACT_REPLAY_COMPLETE`.

Test a callback selecting an unobserved legal action and expect `UNKNOWN_BRANCH` without any fabricated resulting state.

Test illegal action and expect `POLICY_INVALID_ACTION`.

- [ ] **Step 2: Add a hindsight-leakage trap test**

Construct a world containing a future winning branch with metadata impossible to know at the current prefix. The callback receives only the current decision state, current available actions, and outcomes already traversed. Assert that unrevealed observation IDs/outcomes are absent from `prefix`.

- [ ] **Step 3: Implement multi-observation traversal**

For one exact `snapshot_id + action`, replay every recorded observation, producing separate factual derived trajectories. Memoize `(snapshot_id, policy_state_hash)` and stop at 10,000 derived trajectories with `REPLAY_COMPLEXITY_LIMIT`; never silently sample or approximate.

- [ ] **Step 4: Assert zero model-call surface**

Replay module imports only deterministic local modules. Add a static test that source contains no agent profile invocation, provider SDK, `invoke_subagent`, network client, or shell execution import.

- [ ] **Step 5: Run tests and commit**

```bash
node --test runtimes/antigravity/.agents/dream/dream.test.mjs
git add runtimes/antigravity/.agents/dream
git commit -m "feat(dream): add prefix-only exact replay"
```

---

### Task 9: Deterministic Outcome Evaluator and Replay Report

**Files:**
- Create: `runtimes/antigravity/.agents/dream/evaluator.mjs`
- Modify/Test: `runtimes/antigravity/.agents/dream/dream.test.mjs`

**Interfaces:**
- Produces `evaluateTrajectory(trajectory) -> factual summary`.
- Produces `compareTrajectoryFacts(a, b) -> { relation, reason }` for lexicographic reporting only.
- Produces `createReplayReport({ world, replay })`.

- [ ] **Step 1: Add RED tests for hard invalidation**

Any trajectory containing a governance/scope violation, orchestrator/reviewer product write, unattributed mutation, stale acceptance evidence, failed-tool-as-success, Two-Key bypass, unresolved Human Gate treated as success, illegal action, or invalid provenance must be `{ eligible:false }`.

- [ ] **Step 2: Implement factual outcome aggregation**

Report terminal state, evidence completeness, first-pass acceptance, retries/reasons, model calls, role turns, tool calls, tokens, latency, and useful-work ratio only when factual data exists. Preserve `null` for AGY uncached input tokens.

- [ ] **Step 3: Implement immutable lexicographic comparison for reports**

Order only:

```text
Safety/Fidelity
Acceptance
Evidence Completeness
First-pass Acceptance
Retry cost
Model calls per accepted task
Tokens per accepted task
Latency
```

No weighted sum and no lower-priority compensation for a higher-priority regression.

- [ ] **Step 4: Test `UNKNOWN_BRANCH` support semantics**

Unknown support is not counted as failure. Comparison returns `INSUFFICIENT_SUPPORT`/`NEEDS_EXPLORATION` rather than ranking an unsupported trajectory against a factual one.

- [ ] **Step 5: Run tests and commit**

```bash
node --test runtimes/antigravity/.agents/dream/dream.test.mjs
git add runtimes/antigravity/.agents/dream
git commit -m "feat(dream): add factual replay evaluator"
```

---

### Task 10: Installer, Ignore, Test Runner, and Cross-Runtime Hygiene

**Files:**
- Modify: `.gitignore`
- Modify: `scripts/install-antigravity.mjs`
- Modify: `tests/installers/installers.test.mjs`
- Modify: `tests/cross-runtime/cross-runtime-firewall.test.mjs`
- Modify: `scripts/contamination-check.mjs`
- Modify: `package.json`

**Interfaces:**
- Installed AGY runtime includes `.agents/dream/` code but no `.agents/dream-data/` history.
- `npm run test:dream` executes deterministic Dream tests.
- `npm test` includes Dream tests without changing Codex behavior.

- [ ] **Step 1: Add installer RED tests**

After AGY installation assert:

```js
assert.equal(existsSync(join(tempProject, ".agents/dream/canonical.mjs")), true);
assert.equal(existsSync(join(tempProject, ".agents/dream-data")), false);
assert.equal(existsSync(join(tempProject, ".agents/state/dream/pending-decisions")), false);
```

The installer may create empty standard state/telemetry directories as before, but must not copy local Dream state/history.

- [ ] **Step 2: Update installer copy list**

Copy `.agents/dream/` as versioned runtime code. Do not copy `.agents/dream-data/`. Ensure any generated `.agents/state/dream/` data is removed if present in a dirty source checkout before creating `.gitkeep` files.

- [ ] **Step 3: Update `.gitignore`**

Add:

```gitignore
.agents/dream-data/*
!.agents/dream-data/.gitkeep
.agents/state/dream/*
!.agents/state/dream/.gitkeep
```

Do not ignore versioned `.agents/dream/` source.

- [ ] **Step 4: Extend cross-runtime firewall**

Codex scan must fail if `.codex/` imports or references AGY Dream runtime paths. AGY Dream source is scanned for active GPT model assignments and benchmark-specific hardcoding. Do not ban neutral words like `policy` or `replay` from shared docs.

- [ ] **Step 5: Add scripts**

`package.json`:

```json
"test:dream": "node --test runtimes/antigravity/.agents/dream/dream.test.mjs"
```

Insert it into `npm test` after AGY routing/hooks and before cross-runtime/installers so foundation failures stop early.

- [ ] **Step 6: Run installer/firewall/full deterministic suite and commit**

```bash
npm run test:dream
npm run test:installers
npm run test:firewall
npm run check:contamination
npm test
git add .gitignore scripts package.json tests runtimes/antigravity/.agents/dream
git commit -m "test(dream): enforce install and runtime isolation hygiene"
```

---

### Task 11: Foundation Closure, Phase-Gate Verification, and Documentation

**Files:**
- Modify: `runtimes/antigravity/README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/reliability.md`
- Create: `docs/dream-layer.md`
- Create: `benchmarks/turn-economy/results/dream-foundation-v1.json`
- Test/verify existing suites only; do not add a new artificial Task 7 benchmark.

**Interfaces:**
- Documentation describes record-only scope and how to inspect/rebuild sealed worlds/replay locally.
- Closure artifact records deterministic and live regression evidence without claiming unsupported counterfactuals.

- [ ] **Step 1: Document the exact Phase-1 authority boundary**

`docs/dream-layer.md` must state plainly:

```text
Dream records and replays.
Dream does not choose a learned route in Foundation v1.
History does not enter online model context.
Unknown replay branches remain UNKNOWN_BRANCH.
```

Document `.agents/dream/`, `.agents/state/dream/`, `.agents/dream-data/`, sealing requirements, and rebuildability from telemetry.

- [ ] **Step 2: Run routing parity matrix from deterministic fixtures**

Use the fixture table from Task 3. Record fixture count and exact mismatch count in the closure artifact. Required: `routing_parity_percent = 100`, `routing_parity_mismatches = 0`.

- [ ] **Step 3: Run all offline verification**

```bash
npm test
npm run check:contamination
npm run doctor
```

Required: all exit 0.

- [ ] **Step 4: Measure Foundation overhead without changing benchmark semantics**

Use a local fixture/common workspace and record:

- Dream decision-recording CPU duration excluding workspace hash;
- initial workspace hash duration;
- cached workspace hash duration;
- new model turns caused by Dream;
- route/profile before vs after.

Required gate: new model turns = 0; decision-recording CPU target <5 ms excluding hash; common cached workspace hash target <1 s. If the hash exceeds target, verify the runtime falls back to static execution/no-learning for that decision instead of blocking it.

- [ ] **Step 5: Run one live regression only because hooks changed**

Use an already validated ordinary delegated implementation scenario equivalent to the existing Task 3/4 class; do not create a new benchmark category. Verify:

```text
same baseline worker tier/profile
same governance result
no additional parent model turn attributable to Dream
DECISION recorded before delegation
DECISION_OUTCOME correlated factually
world seals successfully if evidence is complete
baseline exact replay reproduces the observed historical path
```

If the live environment cannot provide a factual field, record it as `UNKNOWN` rather than manufacturing it.

- [ ] **Step 6: Create closure artifact**

`dream-foundation-v1.json` must include at minimum:

```json
{
  "schema": "orchestra.dream-foundation-closure.v1",
  "scope": ["MILESTONE_A", "MILESTONE_B", "MILESTONE_C"],
  "routing_parity_percent": 100,
  "new_model_turns": 0,
  "exact_replay_model_calls": 0,
  "unknown_branch_is_non_inferred": true,
  "invalid_world_excluded": true,
  "history_in_online_context": false,
  "cross_runtime_firewall": "PASS",
  "offline_suites": "PASS"
}
```

Populate measured durations/run IDs only from actual execution evidence.

- [ ] **Step 7: Final self-review against Definition of Done**

Verify all ten foundation requirements from spec section 34 are evidenced. Specifically inspect that no new active-policy file, policy designer, branch materializer, shadow, canary, or generalized-evidence mechanism slipped into implementation.

- [ ] **Step 8: Commit closure**

```bash
git add docs runtimes/antigravity/README.md benchmarks/turn-economy/results/dream-foundation-v1.json
git commit -m "docs(dream): close Decision History and Exact Replay foundation"
```

---

## Execution Order and Review Gates

Implement strictly Task 1 -> 11. Each task is independently reviewable and must finish green before the next starts. Do not batch Tasks 1-5 into one change: Tasks 1-4 are pure/new modules; Task 5 is the first active-hook integration and deserves a separate fidelity review. Do not start world sealing/replay until record-only hook tests prove unchanged routing behavior.

At the end of Tasks 3, 5, 8, 10, and 11, run a fresh review focused respectively on routing parity, hook behavior, replay epistemics, runtime isolation, and phase-gate closure.

## Plan Self-Review

- Spec coverage for Milestones A-C: canonicalization/schemas, snapshots, action space, Decision/Outcome records, record-only integration, world sealing, Discovery Tree, Exact Replay, evaluator, storage hygiene, tests, regression verification, and docs are all assigned to explicit tasks.
- Out-of-scope check: Milestones D-H are not implemented.
- Placeholder scan: no implementation step depends on an undefined future component.
- Type/interface consistency: `snapshot_id`, `decision_id`, `DECISION`, `DECISION_OUTCOME`, `UNKNOWN_BRANCH`, world sealing, and replay callback contracts are named consistently throughout.
- Safety check: existing routing/hook governance remains authoritative; Dream I/O failures cannot change primary allow/deny decisions.
