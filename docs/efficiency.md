# Context Diet & Efficiency

Multi-agent coordination can easily exhaust context windows and inflate token costs if agents repeatedly dump entire files, in-line raw diffs, or poll background tasks in tight loops. Orchestra implements systematic efficiency passes to enforce context discipline.

---

## 1. References Over Replication

- **File Pointers**: Handoffs pass file paths and line ranges (`src/core/biquad.ts#L40-L90`), never entire file bodies.
- **Evidence IDs**: Verification results are referenced by execution IDs in the Evidence Ledger rather than duplicating stdout across multiple turns.
- **Compact Packets**: Workers return compact completion summaries with changed paths, test exit codes, and key risks.

---

## 2. Pre-Context Output Gate & Large File Guard

- Commands with stdout >64 KB or >300 lines are intercepted before entering the model's context window.
- The raw output is written to disk under `.agents/artifacts/outputs/output-<id>.log`.
- A compact preview packet `[OUTPUT_TRUNCATED]` containing the first 100 lines and last 50 lines is returned to the model.
- The **Large File Guard** intercepts shell commands like `cat file.json` or `jq '.' file.json` on files exceeding 200 KB, preventing context floods.

---

## 3. Search-to-Window Navigation

- Agents are guided to search before reading:
  1. Use `grep_search` to locate exact line numbers;
  2. Use `view_file` with explicit `StartLine` and `EndLine` to read only the relevant function or block.
- Avoid reading entire large source files when inspecting isolated symbols.

---

## 4. Reactive Wakeup & Polling Discipline

- Long-running commands (>10 seconds) execute as background tasks.
- Agents must **not** poll `manage_task(Action='status')` in a loop.
- The runtime provides **Reactive Wakeup**: the agent yields execution, and the system automatically wakes the agent when the task completes.
- Polling is capped to prevent coordination overhead.

---

## 5. Direct Action Fast Path

Routine operational requests ("run tests", "show git status", "commit changes") do not spawn worker subagents, author scope contracts, or run multi-step acceptance ceremonies. They execute via single-command operations and conclude directly.

---

## 6. Direct Work Turn Economy

Direct Work applies the same economy principle to normal bounded product changes: expensive control reasoning is used to compress the decision, while cheap workers expand that decision into code without rediscovering the task.

The expected shape is:

```text
control resolve
  -> one bounded implementer
  -> candidate
       |-> evidence / CI
       `-> independent Quick Audit (when required)
  -> control acceptance
```

The implementer is restricted to `NONE` or semantic `DIRECTED` discovery. Broad repository exploration, alternative-solution search, unauthorized test mutation, and investigation of unrelated or uncertain failures are not part of the execution budget.

Post-candidate evidence and Quick Audit are planned as independent parallel branches. Mechanical or explicitly low-risk work may skip Quick Audit while still satisfying its required evidence.

Turn-economy instrumentation tracks the following canonical fields without fabricating unavailable values:

- `control_turns`
- `worker_turns`
- `repository_discovery_ops`
- `redundant_reads`
- `turns_to_first_edit`
- `delegations`
- `model_handoffs`
- `quick_audit_invocations`
- `candidate_generations`
- nullable `approximate_cost`

Representative promotion probes cover a bounded bug fix, an explicitly authorized regression-test change, an unrelated external failure returned to control, and a Quick Audit blocking finding followed by one bounded Delta Packet.

---

## 7. Semantic Retrieval Shadow Layer

Orchestra 0.7 introduces an experimental Jev semantic lab under `experiments/jev/`.

The provider transcript remains append-only/provider-managed. Jev never compacts or deletes transcript history.

The external-memory path is:

```text
factual memory
 -> deterministic candidate generation
 -> sanitized bounded projection
 -> Jev semantic ranking
 -> deterministic top-K/byte budget
 -> original factual reference
```

Mandatory packet content is never rankable. Goal, Scope Contract, path boundaries, acceptance criteria, required evidence, retry state and governance state remain deterministic.

Jev currently runs offline/shadow only. Retrieval Assist code is fail-closed behind a factual evaluation report, matching human approval and an explicit local feature flag.


---

## 8. Codex Native Context Packet

Orchestra 0.8 adds the same context-diet safety property to the Codex runtime
without depending on Antigravity hooks.

`.codex/astra-orchestra/context-packet.mjs` builds worker packets from a
non-rankable mandatory core plus bounded auxiliary references. The mandatory
core contains task identity, Scope Contract, acceptance criteria, required
evidence, retry/mutation state, blockers, and Human Gate state.

Auxiliary context defaults to at most 8 references and 16 KiB of reference
metadata. Pinned governance references are never silently dropped.

The Codex packet boundary rejects raw transcript/messages, prompts, hidden
reasoning/thinking, raw stdout/stderr, credentials, secrets, and environment
objects. Outputs above 64 KiB or 300 lines are classified
`PERSIST_AND_REFERENCE`; files above 200 KiB default to
`SEARCH_THEN_WINDOW` when no precise symbol/line anchor is already known.

These are deterministic packet/output decisions. Provider-native transcript
management remains owned by Codex.

---

## 9. Cross-Provider Turn Economy

Cross-provider execution is deliberately **not** the default worker lane. The local provider remains cheaper in coordination turns and avoids an unnecessary model handoff; the extra provider is used only when independent critical review or an explicit second opinion justifies that cost.

The neutral request reuses the canonical task/Implementation Packet facts and reduces them to a bounded Worker Envelope. It does not ship the originating transcript, hidden reasoning, arbitrary chat summaries, raw environment objects, or the full Work Lease. The external provider returns a bounded `DelegationResult`; raw provider output is not promoted into authority merely because another model produced it.

Capability discovery is model-free. Orchestra probes Git worktree support and provider CLI version/help surfaces only; it does not install a provider, log in, or spend an inference call just to determine readiness. If the optional sibling is absent, normal same-provider execution continues without cross-provider model cost.

Recursion is denied and the routing policy permits at most one cross-provider delegation per logical stage. This prevents a second-opinion or review request from becoming an unbounded provider ping-pong. Provider-reported usage or cost may be retained when factual; Orchestra does not synthesize token, latency, or cost values that the target did not report.

---

## 10. Parallel Implementation 2

Parallel implementation is an explicit optimization for a task that CONTROL has already decomposed into exactly two bounded, independent implementation shards. It is not selected merely because Codex and Antigravity are both available, and serial Direct Work remains the default.

The cost model is deliberately narrow: both workers reuse one resolved control decision, start from the same source snapshot in independent hardened clones, and receive only their own Implementation Packet and mutation scope. This can shorten the critical path when the two shards are genuinely independent without paying for two separate control investigations.

Before dispatch, Orchestra must prove the writable scopes are disjoint. After both workers finish, broker-derived `changedPaths` must also be disjoint. The two member artifacts are then applied in a third isolated composition clone and sealed as one Composite Mutation Artifact. CONTROL performs one inspect/promote/discard lifecycle against that composite; workers never create Candidate, Evidence, Acceptance, publication, or finish authority.

The optimization is fail-closed and atomic from the canonical workspace perspective. A failed worker, provider unavailability, factual overlap, artifact tamper, composition conflict, stale baseline, or promotion failure produces no partial canonical mutation and never silently falls back to serial/manual implementation. Runtime updates are also blocked while a parallel group is in flight so the execution plane cannot change underneath active workers.
