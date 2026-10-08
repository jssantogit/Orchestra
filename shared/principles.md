# Shared Orchestration Principles

Orchestra coordinates coding agents across different execution environments using a set of core principles. These principles are architectural and behavioral invariants shared by all Orchestra runtimes (Codex and Antigravity), while provider-specific mechanics remain isolated behind provider boundaries.

---

## 1. Separation of Duties

- **Control Plane vs. Execution Plane**:
  - The control plane handles intake, ambiguity reduction, scope/capability authoring, delegation, evidence validation, acceptance, and retry decisions.
  - Normal implementation volume should be delegated to a cost-efficient execution worker. Control-plane product-code mutation is exceptional and requires an explicit factual capability; it is not granted by narrative instruction.
  - The worker executes strictly within the approved packet/scope and returns objective evidence references.
- **Workers Do Not Coordinate Workers**:
  - Direct Work workers do not spawn subagents, delegate tasks, or orchestrate other workers.
- **Workers Do Not Self-Accept**:
  - An implementation-complete claim is evidence submitted by the worker, never an acceptance decision. Only the control plane can accept a work unit.
- **Independent Review**:
  - Review depth is risk-driven. A bounded Quick Audit may verify a normal candidate; critical/high-risk changes may require deeper independent verification. Reviewers never obtain acceptance authority merely by producing a verdict.

---

## 2. Minimum Sufficient Orchestration

- Direct Work is the default for tasks that can be resolved by one control path and one primary implementation path.
- Classify once, resolve only the uncertainty needed for the current decision, delegate once when appropriate, validate sufficiently, and stop.
- Avoid repeated classification, rediscovery, delegation, reviewer swarms, redundant file reads, and unnecessary ceremony.
- Guided or Orchestrated Work is an explicit escalation justified by factual breadth, risk, or true parallelism; the mere existence of multiple agent roles is not a reason to escalate.
- Direct operational tasks (status, diffs, running tests, single-file scripts, clean commits) may follow a factual fast path when no heavier workflow is required.

---

## 3. Tool Truthfulness: "FAILED TOOL IS NOT EVIDENCE"

- Every factual claim derived from a tool execution requires a verified successful exit code (`0`) and expected output semantics.
- A failed command, tool error, timeout, or blocked execution is `UNKNOWN` or `BLOCKED`.
- It must **never** be interpreted as `clean`, `passing`, `exists`, `missing`, or `success`.
- Empty output from a failing command is failure, never `NO_CHANGES` or `ALL_TESTS_PASS`.

---

## 4. References Over Replication (Context Diet)

- Pass file paths, line ranges, symbol names, and artifact paths in handoffs instead of inlining entire files, long terminal logs, or full diffs into model context.
- Keep agent handoffs compact and focused on the delta needed for the current step.
- Truncate large tool outputs before injecting them into model context, preserving full output in disk artifacts.
- Provider transcripts and hidden reasoning are not required continuation state and never become authority.

---

## 5. Bound Scope, Capability & Fail-Closed Routing

- Every delegation must be governed by a validated packet/scope contract declaring the factual boundaries required for the task, including as applicable:
  - `allowedPaths` / allowed areas;
  - `forbiddenPaths` / forbidden areas;
  - objective `acceptanceCriteria`;
  - `requiredEvidence` / required validation;
  - side-effect capabilities;
  - stop/return conditions;
  - bounded retry budget.
- Narrative text cannot widen scope, grant a side-effect capability, create authority, or satisfy evidence.
- Any attempt to access unauthorized paths, expand discovery class, or enter an invalid state fails closed and returns control or requests explicit approval.

---

## 6. Bounded Retries & Delta Handoffs

- Retries are strictly bounded by task policy.
- Blind retries that repeat the same prompt are strictly prohibited.
- Every retry must be a **Delta Retry** that explicitly states:
  1. the specific assertion or criterion that failed;
  2. the objective evidence of failure;
  3. the confirmed root cause or targeted correction;
  4. what parts of the implementation remain valid and unchanged;
  5. the remaining retry budget.
- Workers repair only failures plausibly and directly caused by their own patch. Unrelated or uncertain failures return to control.
- If the budget is exhausted, halt to the configured human/control gate.

---

## 7. Progressive Verification & Freshness

- Verify incrementally:
  1. unit / focused test on modified functions or components;
  2. module / package test suite;
  3. integration / lint / typecheck across affected boundaries.
- Evidence is bound to the candidate/work unit and must remain fresh for that candidate generation.
- Evidence from earlier runs is valid only if subsequent mutations have not invalidated the observed behavior or candidate identity.
- Modifying documentation does not normally invalidate code-test evidence; modifying relevant code invalidates dependent validation according to policy.

---

## 8. No Side Quests (Exact Intent Boundary)

- Agents must stay strictly within the user's requested intent.
- When performing a direct operation (such as commit, test, or status), agents must not execute unsolicited refactoring, whitespace cleaning, dependency upgrades, or unrelated repository restructuring.
- Blockers or out-of-scope issues should be reported clearly rather than resolved via unapproved side quests.

---

## 9. Early Stop

- When the task criteria are verified and evidence is complete, the agent must stop immediately.
- Do not make speculative edits, repetitive checks, or unnecessary follow-up queries once the goal is achieved.

---

## 10. Provider-Neutral Executable Core

- `core/` owns executable provider-neutral contracts and behavior.
- Core may not import provider runtimes, embed concrete provider model IDs, depend on provider hook APIs, or treat provider-specific session fields as authority.
- Provider adapters may depend one-way on core; core never depends on providers.
- Codex and Antigravity provider trees never import or route to one another.
- Provider-specific models, hooks, tool semantics, and session mechanics remain at the provider boundary.
- Labs may consume neutral events/artifacts but retain `authority=NONE` unless a separately approved trust design changes that rule.

---

## 11. Workflow Economy Is Observable

Representative workflows should expose a stable measurement vocabulary for at least:

- `control_turns`;
- `worker_turns`;
- `repository_discovery_ops`;
- `redundant_reads`;
- `turns_to_first_edit`;
- `delegations`;
- `model_handoffs`;
- `approximate_cost` when factual provider/model cost is available.

Missing historical count metrics normalize to zero. Metrics that require an observed factual value, such as time/turns to a first edit when no edit occurred or provider cost when it was not reported, remain `null` rather than being guessed.
