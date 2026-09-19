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

## 6. Semantic Retrieval Shadow Layer

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

## 7. Codex Native Context Packet

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
