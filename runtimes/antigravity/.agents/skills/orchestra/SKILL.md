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

### 3. Early Delegation & Same-Turn Delegation
- Orchestrator does NOT explore implementation details for simple/standard tasks.
- Worker owns implementation discovery.
- **Same-Turn Delegation**: When worker profile is known, emit `define_subagent` and `invoke_subagent` together in the SAME first model response (`parent_pre_delegation_turns = 1`, `parent_model_turns <= 3`).
- Scope Contract is embedded directly in `invoke_subagent` prompt (`allowedPaths`, `forbiddenPaths`, `testsRequired`, `requiredEvidence`). Use `testsRequired` only for worker-owned local commands. Use typed `requiredEvidence` for runtime-owned facts and verified remote CI.
- Runtime hooks auto-persist `active-contract.json` and transition state to `DELEGATED`.

### 4. Terminal Delegation Discipline (INVOKE_SUBAGENT IS TERMINAL)
- INVOKE_SUBAGENT IS TERMINAL FOR ACTIVE PARENT WORK.
- AFTER `invoke_subagent` SUCCEEDS: RETURN/YIELD IMMEDIATELY WITH ZERO TOOLS. DO NOT SCHEDULE, POLL, WATCH, OR CREATE A WATCHDOG.
- Zero polling & zero side quests: DO NOT call `schedule`, `manage_task`, `manage_subagents`, `view_file`, `grep_search`, `find_by_name`, or `run_command` during healthy delegated execution. Routine polling, timer scheduling, and inspection side quests are strictly denied by runtime policy.
- No tool is required to "wait". Await asynchronous reactive wakeup on child completion.

### 5. Fresh Evidence & Acceptance Diet
- MODEL CLAIM IS NOT EVIDENCE. Verified runtime/provider facts are evidence.
- Fresh factual evidence is reused without re-running.
- Delegated validation evidence is accepted only after the runtime resolves the child to factual HIGH-confidence `RUNTIME_IDENTITY` and federates its structured record to the active parent task. The binding must remain consistent with task, attempt, mutation sequence, parent, producer role, and candidate commit.
- A dedicated validation subagent may use role `validator` / delegation kind `VALIDATION`. Reviewers are never validation producers for acceptance. Parent-local validation remains valid only when it is a factual orchestrator execution, not a model claim.
- CI-first tasks should set `testsRequired: []` and declare a structured `REMOTE_CI` requirement. GitHub Actions evidence must bind to the current origin/HEAD/workflow and all required jobs.
- Mechanical facts should use runtime-owned `LOCAL_FACT` requirements instead of asking workers to run `test -f`, `git status`, or equivalent commands solely to create evidence.
- If remote CI is still running, enter `CI_WAIT`; do not substitute local validation or create side quests.
- Conclude formal acceptance without additional model-claimed proof whenever the typed Evidence Contract is satisfied.
- Orchestrator acceptance concludes in 1 parent model turn to accept and summarize.
- Acceptance state is recorded deterministically by runtime hooks.

### 6. Pre-Context Output Gate & Large File Guard
- `TOOL_OUTPUT_LIMITS`: max 64 KB (65,536 bytes) or 300 lines inline output.
- Large file dumps on files > 200 KB are intercepted and replaced with compact preview packets.

### 7. Direct Action Fast Path (`DIRECT_ACTION`)
- Operational requests ("git status", "git diff", "run tests", "commit", "push") bypass worker delegation.
- Orchestrator executes directly with 0 subagents (`subagentsAllowed: false`).
- Exact Intent Boundary: strictly no unsolicited refactoring or repo side quests.
