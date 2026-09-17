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

1. **Static Routing Remains Authoritative**: Online routing decisions are strictly owned by [`routing-policy.mjs`](file:///root/projects/Orchestra/runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs). No learned policy, shadow policy, canary deployment, or bandit selector may alter worker or reviewer selection online.
2. **Zero Online Model Overhead**: Dream instrumentation introduces **zero new model turns** and consumes zero online model tokens.
3. **No Context Contamination**: Raw discovery history, previous decision traces, and replay transcripts are **never injected into online prompt context**. Context economy is preserved.
4. **Epistemic Truthfulness**: Exact replay requires exact snapshot identity. Missing, counterfactual, or unobserved branches deterministically return `UNKNOWN_BRANCH`. Dream **never hallucinates or invents** synthetic execution outcomes.

---

## 2. Directory Layout & Architecture

The Dream Layer is isolated within the Antigravity runtime, maintaining strict cross-runtime isolation from the Codex runtime:

```text
runtimes/antigravity/
├── .agents/
│   ├── dream/                      # Committed Foundation Code
│   │   ├── canonical.mjs           # Deterministic JSON canonicalization & SHA-256
│   │   ├── records.mjs             # Canonical record builders & schema validators
│   │   ├── schemas/                # JSON Schema draft-07/2020-12 specifications
│   │   │   ├── snapshot-v1.json
│   │   │   ├── decision-v1.json
│   │   │   ├── outcome-v1.json
│   │   │   └── world-v1.json
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
   ├─► [Subagent Execution] (Worker / Reviewer executes within scope contract)
   │
   └─► [PostToolUse] post-tool-telemetry.mjs
         ├─ Retrieve pending correlation record by key
         ├─ Extract objective evidence ledger facts (exit codes, pass/fail, mutations)
         ├─ Append DECISION_OUTCOME event to telemetry
         └─ Atomically clean up pending correlation file
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
4. **Zero Model Calls**: [`replay-simulator.mjs`](file:///root/projects/Orchestra/runtimes/antigravity/.agents/dream/replay-simulator.mjs) imports no LLM SDKs, executes no subprocesses, and makes no network requests. Replay is 100% deterministic CPU evaluation.

---

## 6. The 8-Tier Lexicographic Evaluator

Trajectory evaluation uses an immutable lexicographic hierarchy defined in [`evaluator.mjs`](file:///root/projects/Orchestra/runtimes/antigravity/.agents/dream/evaluator.mjs). A candidate trajectory must strictly outperform or tie a baseline trajectory at tier $N$ before tier $N+1$ is considered. **No weighted sums or composite scoring functions are permitted.**

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
