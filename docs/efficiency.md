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
