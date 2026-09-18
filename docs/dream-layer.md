# Orchestra Dream Layer Foundation

The Orchestra Dream Layer is an offline, deterministic recursive policy improvement foundation for autonomous coding agents. Grounded in the principles of **Dream-RSI: Recursive Self-Improvement through Evolving Worlds** ([Zheng et al., arXiv:2609.14858, 2026](https://arxiv.org/html/2609.14858)), the Dream Layer explores, evaluates, and optimizes operational delegation policies over factual historical trajectories without modifying foundation model weights, prompts, tool hooks, or safety rules.

---

## 1. Core Authority Boundary

In Foundation v1 (Milestones A–C), the Dream Layer operates under strict **record-only** and **exact-replay** constraints. It is an experimental measurement and replay subsystem under Orchestra governance, never a runtime authority:

```text
Dream records and replays.
Dream does not choose a learned route in Foundation v1.
History does not enter online model context.
Unknown replay branches remain UNKNOWN_BRANCH.
```

### Four Foundational Invariants

1. **Static Routing Remains Authoritative**: Online routing decisions are strictly owned by [`routing-policy.mjs`](../runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs). No learned policy, shadow policy, canary deployment, or bandit selector may alter worker or reviewer selection online.
2. **Zero Online Model Overhead**: Dream instrumentation introduces **zero new model turns** and consumes zero online model tokens.
3. **No Context Contamination**: Raw discovery history, previous decision traces, and replay transcripts are **never injected into online prompt context**. Context economy is preserved.
4. **Epistemic Truthfulness**: Exact replay requires exact snapshot identity. Missing, counterfactual, or unobserved branches deterministically return `UNKNOWN_BRANCH`. Dream **never hallucinates or invents** synthetic execution outcomes.

---

## 2. Directory Layout & Architecture

The Dream Layer is isolated within the Antigravity runtime, maintaining strict cross-runtime isolation from the Codex runtime:

```text
runtimes/antigravity/
├── .agents/
│   ├── dream/                      # Committed Foundation & Milestone D Code
│   │   ├── canonical.mjs           # Deterministic JSON canonicalization & SHA-256
│   │   ├── records.mjs             # Canonical record builders & schema validators
│   │   ├── schemas/                # JSON Schema draft-2020-12 specifications
│   │   │   ├── snapshot-v1.schema.json
│   │   │   ├── decision-v1.schema.json
│   │   │   ├── outcome-v1.schema.json
│   │   │   ├── world-v1.schema.json
│   │   │   └── policy-v1.schema.json
│   │   ├── policies/               # Declarative policies
│   │   │   └── static-policy-v1.json # Declarative static baseline policy
│   │   ├── policy-engine.mjs       # Pure deterministic policy validator & interpreter
│   │   ├── snapshot.mjs            # Deterministic snapshot & workspace manifest builder
│   │   ├── action-space.mjs        # Legal action spaces & compact decision state
│   │   ├── decision-recorder.mjs   # Fail-open decision telemetry & pending correlations
│   │   ├── outcome-recorder.mjs    # Correlated outcome recording & ledger binding
│   │   ├── world-sealer.mjs        # World sealing & fail-closed integrity validation
│   │   ├── discovery-tree-builder.mjs # Factual discovery tree derivation
│   │   ├── replay-simulator.mjs    # Prefix-only exact replay simulator (0 model calls)
│   │   ├── evaluator.mjs           # 8-tier lexicographic trajectory comparison
│   │   └── dream.test.mjs          # Comprehensive deterministic test battery
│   ├── state/
│   │   └── dream/                  # Ephemeral Run State (Ignored, never committed)
│   │       ├── pending-decisions/  # Pending pre-action correlation files (*.json)
│   │       └── workspace-hash-cache.json # High-performance mtime/size hash cache
│   └── dream-data/                 # Durable Offline Data (Ignored, never committed)
│       └── sealed-worlds/          # Tamper-evident sealed worlds (<world_id>.json)
```

---

## 3. The Lifecycle: From Live Execution to Exact Replay

```text
 ONLINE EXECUTION (Record-Only)
   │
   ├─► [PreToolUse] pre-tool-enforce.mjs
   │     ├─ Classify decision (WORKER_TIER, INVESTIGATION_STRATEGY, RETRY_ACTION)
   │     ├─ Derive available legal actions and compact decisionState
   │     ├─ Build pre-action snapshot (workspace manifest, task, contract, env, runtime)
   │     ├─ Append DECISION event to .agents/telemetry/events.jsonl
   │     └─ Atomically write pending correlation file
   │
   ├─► [PostToolUse] post-tool-telemetry.mjs
   │     ├─ Treat successful invoke_subagent as dispatch ACK only
   │     ├─ Preserve pending Dream correlation across asynchronous child execution
   │     └─ Close only factual dispatch failures with exact invocation identity
   │
   ├─► [Subagent Execution] Worker / Investigator executes within scope contract
   │
   └─► [Stop fullyIdle=true] stop-guard.mjs
         ├─ Require exact factual child binding and parent/task/run consistency
         ├─ Resolve the originating Dream correlation from the child binding
         ├─ Append DECISION_OUTCOME exactly once at factual child termination
         └─ Consume the pending correlation with crash/retry recovery
   │
 OFFLINE PIPELINE (Deterministic & Model-Free)
   │
   ├─► 1. World Sealing (world-sealer.mjs)
   │     ├─ Correlate decision with outcome by decision_id and snapshot_id
   │     ├─ Verify actor provenance, scope compliance, and Evidence Ledger references
   │     ├─ Validate event hashes and manifest integrity
   │     └─ Seal world if complete; fail closed (WORLD_INVALID / WORLD_INCOMPLETE) if flawed
   │
   ├─► 2. Discovery Tree Construction (discovery-tree-builder.mjs)
   │     ├─ Group sealed worlds by task and root snapshot
   │     ├─ Represent observed transitions as branches
   │     └─ Mark all unobserved legal actions as explicit UNKNOWN_BRANCH
   │
   ├─► 3. Exact Replay Simulation (replay-simulator.mjs)
   │     ├─ Walk decision tree matching exact snapshot identity
   │     ├─ Invoke policy callback with strictly causal prefix (zero future data)
   │     ├─ Follow observed branch or halt at UNKNOWN_BRANCH
   │     └─ Execute with ZERO model calls and ZERO network requests
   │
   └─► 4. Factual Evaluation (evaluator.mjs)
         ├─ Aggregate terminal trajectory facts (safety, contract, governance, turns, tokens)
         ├─ Apply immutable 8-tier lexicographic comparison (no weighted sums)
         └─ Generate structured replay report
```

---

## 4. World Sealing & Integrity

Sealed worlds are the immutable units of factual evidence in the Dream Layer. A world cannot be sealed unless all integrity checks pass:

- **Manifest Hash**: Canonical SHA-256 hash across all workspace files (excluding ignored build artifacts and ephemeral state), verified against the filesystem.
- **Evidence Provenance**: Decisions must correlate to verified executions in the Evidence Ledger. If child evidence was produced by an unresolved actor or unknown conversation, the world is marked `WORLD_INVALID`.
- **Fail-Closed Semantics**: Missing outcomes (`WORLD_INCOMPLETE`), mismatched decision IDs, tampered event hashes, or unverified mutations permanently exclude a world from replay eligibility.
- **Cache Acceleration**: Workspace manifest generation uses an `mtimeMs` + `size` cache (`workspace-hash-cache.json`), ensuring sub-second cached snapshotting (<250 ms) across hundreds of files while falling back to full re-hashing upon cache corruption.

---

## 5. Epistemic Invariants & Exact Replay

Exact Replay provides a factual baseline for policy evaluation without stochastic model calls:

1. **Exact Snapshot Identity**: A decision step during replay matches an observed step if and only if `snapshot_id` matches exactly. Heuristic similarity or semantic approximation is forbidden.
2. **Strict Causal Prefix**: The policy callback receives only previous steps and the current snapshot. Future outcomes, subsequent mutations, and terminal task results are strictly withheld to eliminate hindsight bias.
3. **Non-Inferred Counterfactuals**: If an alternative policy selects an action that was not observed in the sealed world, replay terminates with status `UNKNOWN_BRANCH`. The simulator **never extrapolates, interpolates, or synthesizes** outcomes for untaken paths.
4. **Zero Model Calls**: [`replay-simulator.mjs`](../runtimes/antigravity/.agents/dream/replay-simulator.mjs) imports no LLM SDKs, executes no subprocesses, and makes no network requests. Replay is 100% deterministic CPU evaluation.

---

## 6. The 8-Tier Lexicographic Evaluator

Trajectory evaluation uses an immutable lexicographic hierarchy defined in [`evaluator.mjs`](../runtimes/antigravity/.agents/dream/evaluator.mjs). A candidate trajectory must strictly outperform or tie a baseline trajectory at tier $N$ before tier $N+1$ is considered. **No weighted sums or composite scoring functions are permitted.**

| Tier | Evaluation Dimension | Criterion | Rationale |
| :---: | :--- | :--- | :--- |
| **1** | `SAFETY_VIOLATIONS` | Minimum violations | Non-negotiable containment and scope enforcement |
| **2** | `CONTRACT_INTEGRITY` | Maximum integrity | Disallowed mutations or unapproved writes disqualify |
| **3** | `GOVERNANCE_INVARIANTS` | Maximum compliance | Two-Key consensus, worker isolation, and single-turn locks |
| **4** | `EVENTUAL_ACCEPTANCE` | Maximum acceptance | Task must reach verified `ACCEPTED` status |
| **5** | `FIRST_PASS_ACCEPTANCE`| Maximum first-pass | Zero retries preferred over retry exhaustion |
| **6** | `TURN_ECONOMY` | Minimum turns | Lower total model turns and delegation turns |
| **7** | `TOKEN_ECONOMY` | Minimum tokens | Lower total token footprint (input + output) |
| **8** | `LATENCY` | Minimum duration | Wall-clock execution time |

If a trajectory terminates in `UNKNOWN_BRANCH`, it represents a **lack of factual support**, not a failure. It cannot be promoted over an observed trajectory, but it is not penalized as an unsafe violation.

---

## 7. Offline Operations & Local Inspection

All Dream Layer operations are accessible via deterministic CLI and test commands:

```bash
# 1. Run full Dream Foundation test suite (63 tests)
npm run test:dream

# 2. Run Antigravity routing parity matrix (21 fixtures)
node --test --test-name-pattern="routing parity matrix" runtimes/antigravity/tests/routing-policy.test.mjs

# 3. Inspect sealed worlds locally (Node.js REPL / script)
node -e '
import { readdirSync, readFileSync } from "node:fs";
import { validateWorld } from "./runtimes/antigravity/.agents/dream/world-sealer.mjs";

const worlds = readdirSync(".agents/dream-data/sealed-worlds").filter(f => f.endsWith(".json"));
for (const file of worlds) {
  const world = JSON.parse(readFileSync(`.agents/dream-data/sealed-worlds/${file}`, "utf8"));
  const val = validateWorld(world);
  console.log(`World ${world.world_id}: valid=${val.valid}, status=${world.sealing_status}`);
}
'

# 4. Replay a sealed world against baseline policy
node -e '
import { readFileSync } from "node:fs";
import { replayExact } from "./runtimes/antigravity/.agents/dream/replay-simulator.mjs";

const world = JSON.parse(readFileSync(".agents/dream-data/sealed-worlds/sample-world.json", "utf8"));
const res = replayExact(world, (decision, prefix) => decision.baseline_action);
console.log("Replay status:", res.status, "Steps replayed:", res.step_count);
'
```

---

## 8. Failure Recovery & Fail-Open Semantics

If any Dream telemetry or recording operation encounters an error (disk full, corrupted JSON, missing permissions), the runtime:
1. Records a diagnostic error (`dreamRecordingError`) in ephemeral state;
2. **Fails open**: allows online execution to proceed uninterrupted;
3. Falls back immediately to standard static routing without attempting online learning;
4. Emits a clean non-zero diagnostic for offline telemetry analysis while preserving user task safety.

---

## 9. Milestone D: Declarative Static Policy Engine & Corrective Closure

Milestone D establishes deterministic declarative policy execution and online policy authority for the three mutable decision classes authorized by Orchestra governance:
- `WORKER_TIER` (`FLASH_LOW`, `FLASH_MEDIUM`, `FLASH_HIGH`)
- `INVESTIGATION_STRATEGY` (`IMPLEMENT_DIRECT`, `INVESTIGATE_FIRST`)
- `RETRY_ACTION` (`RETRY_SAME`, `ESCALATE_WORKER`, `INVESTIGATE_FIRST`, `REPLAN`)

### Architecture & Authority Flow

```text
governance -> decision state -> available_actions -> declarative policy -> authority enforcement -> action
```

1. **Governance Derives Action Space First**: Policy NEVER creates available actions. `deriveAvailableActions` computes the legal action set prior to policy evaluation.
2. **Pure Policy Engine**: [`policy-engine.mjs`](../runtimes/antigravity/.agents/dream/policy-engine.mjs) evaluates declarative policy rules with zero filesystem access, zero network, zero clock access, zero LLM calls, and zero history.
3. **Deterministic Schema & Two-Layer Policy Verification Architecture**:
   - **Structural Schema (`policy-v1.schema.json`)**: Formally defined under standard JSON Schema Draft 2020-12 (`rules` `minItems: 1`, `maxItems: 128`; `rule.id` `minLength: 1`; `additionalProperties: false`, boolean `post_investigation`, authoritative state enum without deprecated states like `PLANNING`).
   - **Normative Semantic Validator (`validatePolicy()`)**: Pure deterministic evaluator in [`policy-engine.mjs`](../runtimes/antigravity/.agents/dream/policy-engine.mjs). Enforces structural conformity plus relational and cryptographic invariants (`min <= max` on numeric ranges, rule ID uniqueness within a policy, content-addressed `policy_id` matching `policy-<sha256(canonical(policy_without_id))>`, and strict <= 64 KiB canonical size limit).
   > [!NOTE]
   > Structural constraints are aligned with policy-v1.schema.json; validatePolicy additionally enforces normative semantic invariants that standard Draft 2020-12 cannot express directly.
4. **Real Router Parity**: `static-policy-v1.json` provides 100% explicit coverage and 100% action parity with the production router (`decideRoute(facts)` -> `classifyBaselineDecision(facts, route)`) across all eligible state combinations, verified by shadow tests.
5. **Real Online Policy Authority**: The PreToolUse hook enforces strict execution identity:
   ```text
   RECORDED_CHOSEN_ACTION == ACTUAL_EXECUTED_ACTION
   ```
   If an orchestrator attempts to invoke a subagent that diverges from the policy's chosen action, the invocation is deterministically DENIED before execution. Zero false DECISION records are created, and zero mismatched subagents are registered. Only verified matching executions record a factual `DECISION` event.
6. **Three Decision-Point Semantics**:
   - `WORKER_TIER`: Governs worker tier selection (`FLASH_LOW`, `FLASH_MEDIUM`, `FLASH_HIGH`). Hook blocks mismatched worker tiers.
   - `INVESTIGATION_STRATEGY`: Governs investigation requirements before implementation (`IMPLEMENT_DIRECT`, `INVESTIGATE_FIRST`). If `INVESTIGATE_FIRST` is selected, worker delegations and early mutations are blocked until investigation occurs. If `IMPLEMENT_DIRECT`, the strategy decision is factually recorded pre-action.
   - `RETRY_ACTION`: Governs failure recovery (`RETRY_SAME`, `ESCALATE_WORKER`, `INVESTIGATE_FIRST`, `REPLAN`). Enforces strict retry budget monotonicity (budget cannot increase) and prevents unauthorized escalation.
7. **Factual Fallback Diagnostics & Self-Host Isolation**:
   - Active policies resolve relative to `import.meta.url` (`loadActivePolicy`), isolating the active runtime image from uncommitted candidate repository edits.
   - Any failure (missing file, JSON syntax error, schema mismatch, content-address hash mismatch, validation error, rule conflict, invalid action, unhandled condition, or exception) falls back safely to `STATIC_ROUTING_FALLBACK` recording the exact factual diagnostic code from the 9 canonical diagnostic cases:
     `MISSING_POLICY`, `MALFORMED_JSON`, `UNSUPPORTED_SCHEMA`, `POLICY_HASH_MISMATCH`, `INVALID_POLICY`, `POLICY_CONFLICT`, `POLICY_INVALID_ACTION`, `NO_MATCHING_RULE`, `INTERPRETER_EXCEPTION`.
8. **Exact Replay Model-Free Callbacks**: Exact Replay uses `evaluatePolicy` directly as a zero-model-call callback function.

---

## 10. Milestone D Integration Hotfix & Architecture Invariant Gate

The Milestone D Integration & Correlation Micro-Hotfixes harden the runtime against edge cases discovered during full-lifecycle testing and formalize the 23 Architecture Invariants:

1. **Exact Investigation Correlation Lifecycle (ACK != COMPLETION)**:
   - `pre-tool-enforce.mjs` creates `investigationInFlight` and persists immutable causal identity for the dispatch, including `correlationKey`, `toolCallId`, parent conversation, expected investigator profile/role, and `delegationKind = INVESTIGATION`.
   - Pending role bindings preserve `originToolCallId`, `originStepIdx`, and `delegationKind` so the eventual child conversation can be causally linked back to the exact investigation dispatch.
   - Successful `PostToolUse(invoke_subagent)` is an **acknowledgement only**. It may enrich the factual child conversation ID, but it MUST NOT set `post_investigation`, consume `investigationInFlight`, or close the Dream `DECISION_OUTCOME`.
   - `manage_subagents` is observability/recovery only and is never a completion boundary.
   - Factual completion occurs at the terminal `Stop` event of the exact causally-bound investigator child. The Stop must match child identity, parent identity, `delegationKind = INVESTIGATION`, and `originToolCallId`; task/run identity must not conflict.
   - Parent yield with `fullyIdle = false`, wrong child Stop, stale child identity, ambiguous identity, role/profile-only identity, or mismatched origin call all fail closed and leave the investigation in flight.
   - Factual dispatch failure may terminate the attempt only with exact invocation identity and preserves `post_investigation = false`.
   - Successful factual child completion sets `post_investigation = true`, consumes `investigationInFlight`, and records the matching Dream `DECISION_OUTCOME` exactly once.
   - The same causal boundary applies to normal worker decisions: a successful worker dispatch ACK cannot close `WORKER_TIER` or `RETRY_ACTION`; their outcomes are recorded only on the factual terminal Stop of the exact bound worker child.
   - `INVESTIGATION_STRATEGY = IMPLEMENT_DIRECT` is also tracked as an in-flight decision and closes only when the exact worker reaches factual terminal Stop; it cannot remain as a permanent pending decision after the first mutation.
   - Recorder durability is ordered so a DECISION is never published without durable pending correlation, and outcome retry recovery avoids duplicate `DECISION_OUTCOME` events after an append-before-consume interruption.
2. **Explicit REPLAN State Machine Transition**:
   - Generic tool triggers (`write_to_file`, `run_command`) never induce implicit replans.
   - When `RETRY_ACTION` policy evaluates to `REPLAN`, the transition `currentState -> PLANNED` is validated against Orchestra state machine rules (`validateStateTransition`), `DECISION(REPLAN)` is recorded immediately pre-transition, state is deterministically set to `PLANNED`, and the worker retry is denied with no lingering pending requirement. Invalid transitions fail closed to `HUMAN_GATE`.
3. **Structural Policy Contract Parity & Truthfulness**:
   - Strict structural alignment between JSON Schema Draft 2020-12 and pure JavaScript `validatePolicy()` across all properties (`base_policy`, `description`, `created_at`, `rule.description`).
   - Truthfulness is enforced: structural representable constraints (schema) and normative semantic invariants (`validatePolicy()`) are explicitly partitioned and verified.
4. **Architecture Invariant Gate (ARCH-001 to ARCH-023)**:
   - Executed via `npm run test:architecture-invariants` (`tests/architecture-invariants/dream-authority.test.mjs`), validating both normative and adversarial conditions across all 23 architectural boundaries:
     - `ARCH-001`: Immutable Governance Over Dream
     - `ARCH-002`: Zero Online Context Overhead & No Raw History In Context
     - `ARCH-003`: Exact Replay Epistemic Invariant
     - `ARCH-004`: Declarative Schema-Valid Policy Invariant
     - `ARCH-005`: Fail-Safe Fallback to Validated Static Routing
     - `ARCH-006`: Cross-Runtime Isolation
     - `ARCH-007`: Phase 1 Record-Only Baseline Behavioral Identity
     - `ARCH-008`: Dream Never Increases Authority or Budgets
     - `ARCH-009`: Action-Space Governance Construction
     - `ARCH-010`: Pure Content-Addressed Cryptographic Integrity
     - `ARCH-011`: Independent Baseline & Action-Leakage Freedom
     - `ARCH-012`: Causal Pre-Action Decision Recording
     - `ARCH-013`: Exact Investigation Correlation Lifecycle
     - `ARCH-014`: Authoritative REPLAN State Transition
     - `ARCH-015`: RETRY_SAME Exact Worker Identity
     - `ARCH-016`: Active Self-Host Image Isolation
     - `ARCH-017`: Policy Contract Truthfulness
     - `ARCH-018`: Exact Replay Remains Model-Free
     - `ARCH-019`: Factual Investigator Completion Boundary
     - `ARCH-020`: Delegated Worker ACK Is Not Decision Outcome
     - `ARCH-021`: IMPLEMENT_DIRECT Decision Completes With Its Worker
     - `ARCH-022`: Retry Escalation Requires Factual Previous Worker Identity
     - `ARCH-023`: Retry Budget Is Factual, Never Manufactured
     - `ARCH-024`: Pending Uniqueness Is Not Factual Child Identity
     - `ARCH-025`: Investigation Authority Is Read-Only
     - `ARCH-026`: Sealed World Material Integrity
     - `ARCH-027`: Explicit Exploration Authority Is Non-Escalating
     - `ARCH-028`: Exploration Budget Is Hard Across Stop Boundary

---

## 11. Milestone E: Explicit Exploration Lab

Milestone E adds a deliberately **opt-in, local/offline** mechanism for observing one previously unknown legal branch without weakening online governance.

### Safety boundary

- Automatic exploration remains **OFF**.
- Exploration is never executed in the primary workspace. `prepare` materializes a physical sibling under the OS temporary directory from a captured `BranchSeed`.
- The immutable budget is: **1 sibling branch**, **2 model calls**, **5 minutes**.
- `NORMAL` decisions are eligible by default. `MAJOR` requires explicit approval at capture time (`--approve-major`). `CRITICAL` and `HUMAN_GATE` states are ineligible.
- The committed runtime keeps the normal A-D hook topology unchanged while exploration is OFF. During `prepare`, only the isolated sibling's `.agents/hooks.json` is overlaid: its existing `PreToolUse` becomes an E wrapper and a sibling-only `PostInvocation` budget guard is added.
- The E `PreToolUse` wrapper blocks external/irreversible effects first, then delegates every allowed tool to the original A-D `pre-tool-enforce.mjs`; E can reduce authority but never grant authority the baseline firewall would deny.
- Shell commands are fail-closed to a small local/read-only validation allowlist. The exploration runner accepts only Antigravity CLI executables (`agy` / `antigravity`), forces the CLI `--sandbox` override, and rejects explicit permission/sandbox bypass flags.
- The sibling-only `PostInvocation` guard terminates the exploration loop when the second model call completes or the deadline is exhausted; the Stop Guard independently refuses to reopen an exhausted exploration loop.
- Conversation IDs, execution IDs, correlations, role bindings, locks, telemetry identity, PIDs, ports, and timestamps are not cloned from the factual run.
- The first explored decision remains causally attached to the factual source `snapshot_id`; regenerated ephemeral runtime identity does not redefine the historical root.
- The primary workspace manifest is checked again before collection. Any drift rejects collection.
- Exploration only writes a new sealed factual world. It **never promotes or rewrites the active policy**.

### Why BranchSeed capture is prospective

Milestones A-D persist content-addressed snapshot fingerprints, but historical `DECISION` records do not contain the physical workspace manifest and complete Scope Contract needed to reconstruct an exact isolated sibling. Milestone E therefore refuses to invent a historical state.

An exploration target must first be explicitly armed. The next matching eligible decision captures a local `BranchSeed` containing the physical product-state archive plus the exact policy-visible state, legal actions, Scope Contract, evidence summary, and runtime fingerprint. Historical worlds without such a seed remain replayable through Exact Replay but return `EXPLORATION_SEED_UNAVAILABLE` for physical exploration.

Before materialization, the lab revalidates the seed's decision-state hash, action space, manifest hash, archived workspace payload, sensitive-path rules, and persisted `MAJOR` approval.

### Deterministic branch selection

For the source decision, the lab counts factual observations for every legal action and selects:

```text
LEAST_OBSERVED_LEGAL_ACTION
then stable lexicographic action-id tie-break
```

Milestone E only proceeds when the selected legal action has zero factual observations (`UNKNOWN_BRANCH`). If every legal action has already been observed, no sibling is created.

### CLI flow

```bash
# 1. Explicitly arm capture for the next matching decision.
npm run dream:explore -- arm --repo /path/to/project --decision-type WORKER_TIER

# For MAJOR only, human approval must be explicit at capture time.
npm run dream:explore -- arm --repo /path/to/project --decision-type WORKER_TIER --approve-major

# 2. After the factual decision/world is available, materialize one isolated sibling.
npm run dream:explore -- prepare \
  --repo /path/to/project \
  --world /path/to/world.json \
  --seed /path/to/.agents/dream-data/branch-seeds/<seed-id>/branch-seed.json

# 3. Run Antigravity only inside the returned branch_workspace.
# The wrapper injects --sandbox itself and rejects bypass flags.
npm run dream:explore -- run --workspace <branch_workspace> -- agy

# 4. Seal and collect the explored factual world after the run.
npm run dream:explore -- collect --repo /path/to/project --workspace <branch_workspace>
```

The sibling index is durable under `.agents/dream-data/explorations/` and prevents creating a second sibling for the same world/snapshot/decision-state key.
---

## 12. Milestone F: Offline Policy Lab

Milestone F turns sealed factual history into **candidate policy proposals and deterministic replay evaluations**. It deliberately stops before Shadow Mode, Canary, or policy activation.

### Authority boundary

- The Policy Lab is offline. No online hook imports or calls it.
- `flash-policy-designer` is a tool-less `gemini-3.8-flash-high` subagent. It cannot read files, execute commands, browse, inspect raw history, write code, or activate policy.
- The model never receives raw worlds. It receives only `orchestra.policy-designer-packet.v1`, derived from the sanitized deterministic dataset.
- Candidate policies are stored only under `.agents/dream-data/policy-lab/candidates/` and are revalidated by `validatePolicy()` before replay.
- Milestone F has **no active-policy pointer write path**. Every evaluation records `activation_allowed: false` and names `SHADOW_MODE` as the next milestone required for activation.

### PolicyDevelopmentDataset

`policy-lab.mjs` builds a content-addressed `orchestra.policy-development-dataset.v1` from valid sealed worlds. Input order does not affect `dataset_id`.

The dataset may contain only structured policy-development evidence:

- sanitized policy-visible state buckets and chosen-action counts;
- exact legal-action support, including unknown/ambiguous coverage;
- terminal outcome counts and first-pass acceptance rate;
- retry-reason counts;
- p50/p90 model-call, retry, token, and latency costs;
- at most 20 sanitized replay counterexamples;
- the current validated baseline policy.

Raw user prompts, terminal logs, outcome free text, file/web contents, conversation transcripts, and other unsanitized history are not copied into the dataset or designer packet.

### Frozen train / holdout split

Each factual root lineage is assigned deterministically by SHA-256 to an **80% TRAIN / 20% HOLDOUT** split. The split is stored in the content-addressed dataset, so every descendant/world in the same root lineage remains on the same side for that improvement cycle.

Milestone F reports the future promotion sample gate (`>=100` supported train lineages and `>=30` supported holdout lineages) but does not use that gate to activate anything. With smaller samples, candidates may still be retained as offline recommendations.

### Designer cycle

A content-addressed cycle always includes the current baseline. Cycle state is protected by `state_hash` and cannot be reopened to reset the designer-call budget.

- Maximum designer calls per cycle: **2**.
- Maximum candidates per call: **4**.
- Issuing a designer packet reserves that call and assigns a content-addressed `packet_id`; repeated reads of the pending packet are idempotent.
- The designer response must echo the pending `packet_id`. Evaluation cannot skip a pending call.
- Call 1 may propose up to four candidate JSON policies.
- After deterministic replay feedback, call 2 may propose up to four revisions.
- An oversized submission consumes its designer call instead of providing a free retry.
- Candidate `policy_id` and timestamps supplied by the model are discarded; the lab computes deterministic content-addressed identity.

### Exact Replay and evaluation

Every baseline/candidate policy is evaluated with the existing zero-model-call `replayExact()` engine. The candidate is a declarative overlay: a non-matching rule falls back to baseline; conflict/illegal action makes the replay invalid.

TRAIN and HOLDOUT are summarized independently. Evaluation remains lexicographic and non-compensatory:

1. Safety / Fidelity
2. Acceptance
3. Evidence Completeness
4. First-pass Acceptance
5. Retry Cost
6. Model Calls
7. Tokens
8. Latency

`UNKNOWN_BRANCH` never counts as failure or guessed success. Any unsupported candidate divergence becomes `NEEDS_EXPLORATION`.

After hard/quality gates, operational improvement is material when at least one specified threshold is met: >=5% fewer model calls per accepted task, >=10% fewer retries per accepted task, or >=2 percentage-points first-pass acceptance. Smaller improvements may be retained but are not labeled material.

### CLI flow

```bash
# Build and persist the deterministic dataset from sealed worlds.
npm run dream:policy-lab -- dataset --repo /path/to/project

# Open (or reopen) the deterministic improvement cycle.
npm run dream:policy-lab -- open --repo /path/to/project

# Produce the sanitized packet for the tool-less flash-policy-designer.
npm run dream:policy-lab -- packet --repo /path/to/project --cycle <cycle.json>

# Submit the designer's JSON output: {"packet_id":"packet-...","candidates":[...]}.
npm run dream:policy-lab -- submit --repo /path/to/project --cycle <cycle.json> --candidates <candidates.json>

# Run zero-model-call Exact Replay across frozen TRAIN and HOLDOUT.
npm run dream:policy-lab -- evaluate --repo /path/to/project --cycle <cycle.json>
```

Candidate statuses include `NEEDS_EXPLORATION`, `INELIGIBLE`, `REGRESSION`, `EQUIVALENT`, `IMPROVEMENT_BELOW_MATERIALITY_THRESHOLD`, and `RECOMMENDATION_CANDIDATE`. None of these statuses activate a policy in Milestone F.
---

## 13. Milestone G: Zero-Impact Shadow Mode

Milestone G allows one evaluated candidate policy to compute a **private counterfactual action on each factual DECISION** without executing that action or exposing it to the model.

### Authority boundary

- Shadow is explicitly enabled by CLI from a persisted Milestone F evaluation/candidate pair.
- Only schema-valid, content-addressed candidate policies from local Policy Lab artifacts are eligible.
- `REGRESSION`, `INELIGIBLE`, and baseline entries cannot be shadowed.
- Shadow is invoked only after a factual `DECISION` has been durably published.
- The factual `chosen_action` remains the only action returned to the runtime. Candidate action, divergence, support, latency, and Shadow errors are written only under `.agents/dream-data/shadow/`.
- `CRITICAL` and `HUMAN_GATE` decisions are excluded before candidate evaluation.
- Shadow performs no model/tool calls, no writes to active policy state, and no Canary execution.

### Frozen support index

When Shadow is enabled, the runtime builds a content-addressed support index from valid sealed worlds. The index freezes exact support for that Shadow session:

```text
snapshot_id + decision_type + canonical policy-visible state
  -> observed actions + factual outcomes
```

A divergent candidate action is labeled `EXACT_SUPPORTED` only when that exact factual branch already exists. Otherwise it is `UNKNOWN_BRANCH`. Shadow never infers support by similarity.

### Observation semantics

Each factual DECISION produces at most one idempotent `orchestra.shadow-observation.v1` artifact for the active Shadow session. It records:

- factual baseline action;
- private candidate action;
- whether the candidate diverged;
- exact replay-support status;
- candidate-policy evaluation latency;
- eligibility/exclusion reason;
- deterministic errors, if any.

The observation artifact is not written to `events.jsonl`, active state, Scope Contract, tool return values, or model-visible context.

### Canary-readiness gate

A Shadow report requires:

- at least **50 eligible Shadow decisions** before Canary review;
- no Shadow policy-evaluation errors;
- `UNKNOWN_BRANCH` on no more than **20% of divergent decisions**.

If more than 20% of divergences are unsupported, status is `GATHER_SUPPORT`. If fewer than 50 eligible decisions exist, status is `COLLECT_MORE_DECISIONS`. Passing all Shadow gates produces only `READY_FOR_HUMAN_CANARY_REVIEW`.

Milestone G still emits:

```text
activation_allowed: false
canary_execution_allowed: false
human_approval_required: true
```

Actual candidate execution belongs to Milestone H.

### CLI flow

```bash
# Explicitly enable one validated Policy Lab candidate for Shadow observation.
npm run dream:shadow -- enable \
  --repo /path/to/project \
  --candidate <policy-id> \
  --evaluation <evaluation-id>

# Inspect active Shadow session.
npm run dream:shadow -- status --repo /path/to/project

# Build a zero-impact Shadow report.
npm run dream:shadow -- report --repo /path/to/project

# Stop future Shadow observations. Historical session artifacts remain local.
npm run dream:shadow -- disable --repo /path/to/project
```
---

## 14. Milestone H+: Human-approved Progressive Canary and Promotion

Milestone H+ is the first Dream stage allowed to execute a learned candidate policy. Authority is deliberately progressive: a candidate starts at 5% and may expand only through explicit human-approved stages before any final promotion.

### Gate 1: approve the initial 5% Canary

A Canary can start only from a content-addressed Milestone G report with status `READY_FOR_HUMAN_CANARY_REVIEW`. The CLI requires `--confirm`; a ready Shadow report never becomes live authority automatically.

Selection is deterministic by `SHA-256(task_id + candidate_policy_id) mod 100`. The rollout cohorts are nested:

- stage 0: 5% (`INITIAL_5`), minimum 1 completed factual Canary outcome;
- stage 1: 20% (`EXPANDED_20`), minimum 3 completed factual Canary outcomes in that stage;
- stage 2: 50% (`EXPANDED_50`), minimum 5 completed factual Canary outcomes in that stage;
- stage 3: 100% (`FULL_100`), minimum 10 completed factual Canary outcomes in that stage.

A task selected at 5% remains selected at every later stage. If a factual task ID is unavailable, the task is not canaried.

Runtime eligibility fails closed unless all conditions hold:

- criticality is exactly `NORMAL`;
- task action is local implementation/test/mechanical work;
- task domain is in the conservative local-code allowlist;
- an explicit bounded Scope Contract exists;
- no broad `*`/`**`, control-plane, workflow, remote, or nonlocal scope is present;
- no security/auth/credentials/release/deploy/publish/migration/database/payment/production critical path is detected;
- no Two-Key or independent review requirement exists;
- state is neither `HUMAN_GATE` nor `CRITICAL_REVIEW`.

The current baseline policy is evaluated first. Canary may overlay only a healthy baseline result. A no-match candidate inherits the baseline action; an illegal/conflicting/corrupt candidate rolls the Canary session back and the same decision remains on baseline routing.

### Stage gates: 5% → 20% → 50% → 100%

Each rollout generation counts only decisions and outcomes executed in that generation. A stage cannot advance until:

- at least one live candidate decision exists;
- every candidate decision in the current generation has a factual outcome;
- the stage-specific minimum completed-outcome count is met;
- no Canary rollback has occurred.

A ready nonfinal stage produces only `READY_FOR_HUMAN_STAGE_ADVANCE`. Advancing requires a fresh content-addressed report plus a separate CLI `--confirm`. The runtime writes a content-addressed rollout-approval artifact linked to the previous approval, increments the rollout generation, and rejects stale/replayed reports.

There is no automatic stage advancement. The model, Dream recorder, detached evidence watcher, and Stop Guard cannot silently raise Canary traffic.

### Hard rollback gates

A live Canary is immediately removed from future routing when any of the following is observed:

- candidate policy/schema corruption or interpreter exception;
- illegal candidate action or policy conflict;
- external-side-effect attempt from a task that actually entered Canary;
- governance/control-plane modification attempt;
- required-evidence bypass attempt blocked by Stop Guard;
- exact factual regression: the candidate does not accept a snapshot where the frozen support index proves the baseline action accepted that same snapshot/state.

Canary failures never rewrite factual DECISION/OUTCOME records. Rollback affects only future decisions and normal static/current routing continues.

### Canary reports and final promotion

A report is `COLLECT_CANARY_OUTCOMES` until the current generation is fully observed and satisfies its minimum. Any hard rollback yields `ROLLED_BACK`.

Stages 5%, 20%, and 50% can yield only `READY_FOR_HUMAN_STAGE_ADVANCE`. Only a healthy, fully observed 100% stage can yield `READY_FOR_HUMAN_PROMOTION_REVIEW`.

Promotion is a separate human gate. It requires another CLI `--confirm` against the final 100% report. The candidate and baseline are revalidated and the current runtime baseline must still match the Canary baseline.

Promoted policies are stored content-addressed under:

```text
.agents/dream-data/policies/versions/<policy-id>.json
```

`active.json` contains only the policy ID, policy schema/runtime compatibility, content hash, and human promotion metadata. Writes use `temp + fsync + rename`. Missing/corrupt/incompatible pointers or versions fall back to `static-policy-v1` with diagnostics rather than blocking the task.

The Policy Lab reads this same active-policy store, so the next improvement cycle uses the promoted policy as its baseline.

### CLI flow

```bash
# Gate 1: start at 5% from a ready Shadow report.
npm run dream:canary -- approve \
  --repo /path/to/project \
  --shadow-report <shadow-report-id> \
  --confirm

# Inspect the active stage.
npm run dream:canary -- status --repo /path/to/project

# Build a report after factual outcomes arrive.
npm run dream:canary -- report --repo /path/to/project

# For 5%, 20%, and 50% reports that are ready, explicitly approve the next stage.
npm run dream:canary -- advance \
  --repo /path/to/project \
  --canary-report <canary-report-id> \
  --confirm

# Optional immediate human rollback at any live stage.
npm run dream:canary -- rollback --repo /path/to/project --confirm

# Only after the fully observed 100% report: explicitly promote the policy.
npm run dream:canary -- promote \
  --repo /path/to/project \
  --canary-report <canary-report-id> \
  --confirm
```

Promoted-policy rollback is also explicit and human-gated. `rollback-policy --confirm` restores the exact previous policy recorded in activation metadata (or removes `active.json` when that previous baseline is `static-policy-v1`) and appends a `POLICY_ROLLBACK` history event. Promoted versions are retained.

```bash
npm run dream:canary -- rollback-policy --repo /path/to/project --confirm
```

Automatic stage advancement and `auto_promote` remain forbidden.

---

## 15. Milestone I: Attributable Feedback Plane

Milestone I introduces dense, local, attributable feedback without turning model prose into truth.

A worker may declare:

- `HYPOTHESIS`: a falsifiable model claim;
- `EXPERIMENT`: an exact command plus expected interpretation;
- `OBSERVATION`: created only by the runtime when that experiment binds to factual Evidence Ledger execution;
- `FEEDBACK`: deterministic inference over factual observations.

The runtime states are `UNKNOWN`, `OBSERVED`, `SUPPORTED`, `FALSIFIED`, and `CAUSALLY_VERIFIED`. The last state requires an explicit `MUTATION_AB` design, the same exact factual command changing from FAIL to PASS, and exactly one HIGH-confidence `RUNTIME_IDENTITY` mutation between the two observations. That mutation must overlap the hypothesis `target_paths`; multiple interventions are treated as confounded and remain at most `SUPPORTED`. Causal status cannot be asserted by the model.

Feedback never satisfies an Evidence Contract and never grants routing, write, or acceptance authority.

---

## 16. Milestone J: Context and Side-Effect Trust Boundary

Milestone J formalizes the rule: **data may cross a context boundary; authority may not**.

The runtime classifies information as `RUNTIME_AUTHORITY`, `MODEL_CLAIM`, `UNTRUSTED_CONTEXT`, or `FACTUAL_EVIDENCE_REF`. On every PreInvocation, Orchestra rebuilds a bounded Runtime Continuation Capsule from factual state, contract, identities, evidence references, retry state, and Human Gate state. Narrative summaries and handoff prose are excluded from authority reconstruction.

The side-effect capability model distinguishes local reads/writes/processes from `NETWORK_WRITE`, `REMOTE_REPO_WRITE`, `VCS_REMOTE_WRITE`, and `PUBLICATION`. Remote/public writes are denied unless the active factual Scope Contract (or an exact classified direct-action intent for VCS push) authorizes the capability.

Detected attempts inside handoffs to override scope, evidence, roles, or Human Gates are recorded as untrusted authority claims; they are not promoted into control state.

---

## 17. Milestone K: Full Exploration Policy

Milestone K gives the learned policy control over **whether exploration continues**, not over governance itself.

New policy decision classes are:

```text
EXPLORATION_BRANCHING -> NO_NEW_BRANCH | OPEN_BRANCH
PARALLELISM           -> SERIAL | PARALLEL_2
PRUNE_BRANCH          -> KEEP_BRANCH | PRUNE_BRANCH
STOPPING              -> CONTINUE_EXPLORATION | STOP_EXPLORATION
```

The controller composes Milestone-E isolated siblings rather than allowing parallel writers in the primary workspace. Static non-learnable ceilings are 3 branches, 2 simultaneous siblings, 6 exploration model calls, and 15 minutes total. Each sibling retains E's own 2-call / 5-minute sandbox and external-side-effect firewall.

Standalone Milestone E remains one-sibling by default. K may namespace additional E siblings only when `exploration-lab.mjs` verifies the persisted full-controller session, exact immutable K limits, deadline, fresh branch ordinal, and a per-slot capability token created atomically with `O_EXCL`. This makes the three-branch ceiling race-safe.

Previously selected actions for the same factual source decision are excluded inside the current controller. Before selecting a K alternative, the lab also scans valid sealed worlds and excludes actions already observed at the exact same `snapshot_id + decision_type + state_hash`. A later controller therefore does not pay again for an already known branch; there is no similarity-based inference.

Stopping is quiescence-aware. Explicit stop becomes `STOP_REQUESTED` while a branch or control-decision outcome remains pending. New branches are denied, existing branches may finish to close their factual outcomes, and a successor controller cannot start until the old controller reaches `STOPPED`. Static budget exhaustion is finalized under the same rule.

The static baseline is conservative: exploration continues while budget remains, parallelism defaults to serial, and pruning requires factual invalid/falsified state. A promoted learned policy may choose a different action only when that action is already in the runtime's legal set.

K uses deferred causal observation. `CONTINUE_EXPLORATION`, `OPEN_BRANCH`, and `PARALLELISM` are published before the branch action, but their outcomes remain pending until that branch reaches a factual terminal consequence. A sealed branch world yields attributable policy evidence. Setup/runner/collection failures without a sealed branch world are recorded as factual `attributable: false` observations; the evaluator maps them to `UNKNOWN_BRANCH / INSUFFICIENT_SUPPORT` rather than treating infrastructure trouble as a policy regression.

Each K decision/outcome pair is sealed into an independent replay-eligible one-decision world. This avoids conflating `STOPPING`, `EXPLORATION_BRANCHING`, `PARALLELISM`, and `PRUNE_BRANCH` at one source snapshot. Failed branch materialization still consumes a controller branch slot, closing the retry-budget loophole.

K applies the existing active policy and Canary overlay before execution. Therefore K policy changes still require the same offline dataset/replay, Shadow support, human-approved progressive Canary, and human promotion lifecycle.

### Full-exploration CLI

```bash
# Explicitly create the bounded controller session.
npm run dream:explore-full -- start --repo /path/to/project

# Prepare one isolated branch from an existing factual world + BranchSeed.
npm run dream:explore-full -- prepare \
  --repo /path/to/project \
  --world /path/to/world.json \
  --seed /path/to/branch-seed.json

# Execute the prepared branch by branch ID. Antigravity sandbox forcing remains mandatory.
npm run dream:explore-full -- run \
  --repo /path/to/project \
  --branch <full-branch-id> -- agy <args>

# Seal/collect the result; pruning/stopping decisions are evaluated factually.
npm run dream:explore-full -- collect --repo /path/to/project --branch <full-branch-id>

npm run dream:explore-full -- status --repo /path/to/project
npm run dream:explore-full -- stop --repo /path/to/project --reason "human stop"
```

Milestones I-K add no authority to the model itself: factual evidence, isolation, capability checks, static ceilings, and explicit human gates remain runtime-owned.

