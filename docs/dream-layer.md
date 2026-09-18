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

---

## 11. Milestone E: Explicit Exploration Lab

Milestone E adds a deliberately **opt-in, local/offline** mechanism for observing one previously unknown legal branch without weakening online governance.

### Safety boundary

- Automatic exploration remains **OFF**.
- Exploration is never executed in the primary workspace. `prepare` materializes a physical sibling under the OS temporary directory from a captured `BranchSeed`.
- The immutable budget is: **1 sibling branch**, **2 model calls**, **5 minutes**.
- `NORMAL` decisions are eligible by default. `MAJOR` requires explicit approval at capture time (`--approve-major`). `CRITICAL` and `HUMAN_GATE` states are ineligible.
- External or irreversible effects are blocked by a dedicated `PreToolUse` exploration firewall. Shell commands are fail-closed to a small local/read-only validation allowlist.
- `PostInvocation` terminates the exploration loop when the second model call completes or the deadline is exhausted.
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

# 3. Run Antigravity (or a test harness) only inside the returned branch_workspace.
npm run dream:explore -- run --workspace <branch_workspace> -- agy

# 4. Seal and collect the explored factual world after the run.
npm run dream:explore -- collect --repo /path/to/project --workspace <branch_workspace>
```

The sibling index is durable under `.agents/dream-data/explorations/` and prevents creating a second sibling for the same world/snapshot/decision-state key.
