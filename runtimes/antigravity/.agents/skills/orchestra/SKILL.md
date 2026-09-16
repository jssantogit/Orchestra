---
name: orchestra
description: >-
  Local multi-agent architecture for multi-agent development using Gemini 3.8 Flash Medium (orchestrator), Gemini 3.8 Flash High/Medium/Low (workers), and Two-Key independent critical review.
---

# Orchestra Antigravity ALL-GEMINI Architecture

Orchestra provides a 100% **ALL-GEMINI** local architecture in the Antigravity CLI.
- **Gemini 3.8 Flash Medium (`gemini-3.8-flash-medium`)**: Global Orchestrator and Control Plane.
- **Gemini 3.8 Flash High (`gemini-3.8-flash-high`)**: Complex Implementation Worker, Investigation Specialist, and Independent Reviewer.
- **Gemini 3.8 Flash Medium (`gemini-3.8-flash-medium`)**: Standard Implementation Worker.
- **Gemini 3.8 Flash Low (`gemini-3.8-flash-low`)**: Docs, mechanical fixes, and simple tests.
- **Two-Key Critical Review**: Two independent Flash High reviewers with mandatory consensus. Disagreement halts to `HUMAN_GATE`.
- **Zero Fallback**: Claude, Sonnet, Opus, GPT, and automatic Gemini 3.1 Pro fallbacks are strictly forbidden.

## Operational Rules & Invariants

### 1. Invariant: Orchestrator Does Not Implement
- Orchestrator NEVER directly mutates workspace or product files (`src/**`, `lib/**`, `test/**`).
- All product writes are strictly denied by default for Orchestrator. Implementation is delegated to workers.

### 2. Turn Diet: Minimum Model Turns First
- **Principle**: Minimize full model round-trips. Group independent tool operations into the same model turn.
- **Multi-Tool Native First**: Emit independent reads or edits together in the same model response.
- **Adjusted Priorities**:
  1. MINIMUM MODEL TURNS
  2. Structured/native semantics (`view_file`, `grep_search`, `find_by_name`, `replace_file_content`, `write_to_file`)
  3. Minimum context windows ($[L-35, L+45]$)
  4. Shell fallback (`run_command` for test, typecheck, build, git)

### 3. Early Delegation & Scope Contracts
- Orchestrator does NOT explore implementation details for simple/standard tasks.
- Worker owns implementation discovery.
- Scope Contract is embedded directly in `invoke_subagent` prompt (`allowedPaths`, `forbiddenPaths`, `testsRequired`).
- Runtime hooks auto-persist `active-contract.json` and transition state to `DELEGATED`.

### 4. Reactive Wakeup Discipline
- After calling `invoke_subagent`, immediately stop calling all tools and yield/end turn with 0 tool calls.
- Zero polling: DO NOT poll `manage_subagents` or `manage_task` during healthy delegated execution. Routine polling is strictly prohibited and denied by runtime policy.
- Await asynchronous reactive wakeup on child completion.

### 5. Fresh Evidence & Acceptance Diet
- Fresh test evidence produced by worker is reused without re-running.
- Orchestrator acceptance concludes in $\le 2$ parent model turns (target: 1 turn to accept and summarize).
- Acceptance state is recorded deterministically by runtime hooks.

### 6. Pre-Context Output Gate & Large File Guard
- `TOOL_OUTPUT_LIMITS`: max 64 KB (65,536 bytes) or 300 lines inline output.
- Large file dumps on files > 200 KB are intercepted and replaced with compact preview packets.

### 7. Direct Action Fast Path (`DIRECT_ACTION`)
- Operational requests ("git status", "git diff", "run tests", "commit", "push") bypass worker delegation.
- Orchestrator executes directly with 0 subagents (`subagentsAllowed: false`).
- Exact Intent Boundary: strictly no unsolicited refactoring or repo side quests.
