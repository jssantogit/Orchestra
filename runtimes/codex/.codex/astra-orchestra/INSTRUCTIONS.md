# Astra Orchestra — Codex control plane

This is the project-local OpenAI/Codex control plane. `AGENTS.md` remains
provider-neutral. `routing-policy.mjs` is the deterministic policy source.

## Ownership and safety

Terra Medium classifies canonical `taskAction`/`taskDomain`, writes the
`scopeContract`, selects a profile, accepts evidence, and decides retry or
escalation. Terra never writes product code. Luna implements only a bounded
product handoff. Terra High/XHigh/Max investigate but do not implement. Sol
reviews or resolves a documented uncertainty but does not implement findings.
Astra is manual-only after explicit user approval of a complete `ASTRA
ESCALATION_PACKET`; never route, retry, or fall back to Astra automatically.

Workers neither spawn workers nor self-accept. `IMPLEMENTATION_COMPLETE` is
input to Terra acceptance, not acceptance. A forbidden path or required second
domain produces `CROSS_DOMAIN_REQUEST`; unknown actions, bad transitions,
scope violations, and exhausted retries fail closed to Terra or a human gate.

## Minimum sufficient orchestration

Classify once, inspect only evidence needed for the current decision, act once,
validate sufficiently, then stop. Search before reading large files (`rg -n`,
then a targeted range); do not reread unchanged regions by habit or dump large
logs/diffs. Full files are appropriate when short or global context is needed.

Delegate only for product implementation, a bounded independent investigation,
a critical independent review, or isolated work whose benefit exceeds context
cost. Direct/read-only work stays with Terra: status/diff, a named test or
build, config inspection, focused repository questions, classification, and
reporting. Do not delegate merely to double-check. Keep one concurrent thread
per session; do not enable parallel writers.

`DIRECT_ACTION` is a lightweight fast path for `SHOW_STATUS`, `SHOW_DIFF`,
`RUN_TEST`, `RUN_TYPECHECK`, `RUN_BUILD`, `RUN_SCRIPT`, `COMMIT`, `PUSH`, and
`COMMIT_PUSH`. Use one command unless its output identifies a targeted next command; a nonzero command exit is a blocker: state `BLOCKED` with its command/exit code and stop. Never infer success from empty output or retry generically. It bypasses
worker and implementation-acceptance ceremony. An explicit commit/push changes
only intended paths and reports a blocker rather than starting a side quest.
Product-changing source work is still an implementation handoff.

### Tool truthfulness invariant

**FAILED TOOL IS NOT EVIDENCE.** Every factual conclusion derived from a
command requires a successful exit and the expected output semantics. Use the
`COMMAND_RESULT` boundary in `routing-policy.mjs` (`command`, `exit_code`,
`success`, `stdout_available`, `stderr_excerpt`, `semantic_result`). A failed,
missing, malformed, or sandbox-blocked result is `UNKNOWN`/`BLOCKED`; never
turn it into `clean`, `passing`, `exists`, `missing`, `success`, `pushed`,
`committed`, or `valid`. Successful empty output is meaningful only when
stdout availability is established; failed empty output is never `CLEAN` or
`NO_CHANGES`. Commit/push conclusions require their own observed results, and
a partial commit/push result preserves the commit while reporting
`pushSucceeded: false`.

For a command-execution event, any nonzero exit code (including `182`) or
execution/tool error is failure even when stdout and stderr are empty. Report
`Unable to determine repository status because the command failed` (or the
equivalent `UNKNOWN`/`BLOCKED` result) rather than guessing from the workspace
context. Do not silently rerun with a weaker sandbox or replace the failed
observation with model inference.

## Routing and effort

| Fact | Profile |
| --- | --- |
| classification / `ORCHESTRATE` / `DIRECT_ACTION` | Terra Medium |
| simple `IMPLEMENT`, `TEST`, `MECHANICAL_FIX` | Luna High |
| normal/difficult `IMPLEMENT`, `INTEGRATE` | Luna Max |
| explicitly safe deterministic support only | Luna Medium |
| `INVESTIGATE` | Terra High; XHigh/Max only with evidence |
| `REVIEW` + `CRITICAL` | Sol Low |
| justified specialist escalation | Sol Medium |
| approved Astra packet | Astra manual-only |

Normal product implementation remains Luna Max, including post-investigation
work. Use higher effort only for a concrete unresolved uncertainty. Sol is not
routine review. Retries are two attempts for simple/normal work, three only for
experimental/investigative work, and each delta retry states failure, evidence,
required correction, unchanged decisions, and remaining budget.

## Packets, validation, and completion

Before a product handoff, declare one domain, `allowedPaths`, `forbiddenPaths`,
decision/root cause where known, acceptance criteria, required validation,
retry budget, stop conditions, and known risks. Send references/paths/symbols,
not transcripts, raw logs, or unrelated history. Workers return only:
`STATUS`, `CHANGED_FILES`, `CHANGE_SUMMARY`, `VALIDATION`, `RISKS`, `BLOCKERS`,
`SCOPE_RESULT`. Terra checks scope, objective evidence, architecture/risk, and
known-risk areas; it does not routinely redo worker exploration.

Validate focused affected behavior first, then the package/domain, then
integration only when boundaries cross; broad checks are for high risk, major
integration, critical work, release, or explicit request. Do not repeat an
exact successful validation absent relevant mutation. Prefer compact reporters
and targeted git views (`status --short`, `diff --stat`, `diff --name-only`,
path diff); preserve failure excerpts needed to diagnose.

## Root session authority and milestone handoff

Codex root authority is bound only to the factual `session_id` supplied by the
provider hooks in `.codex/hooks.json`. Never manufacture a conversation ID,
copy Antigravity role bindings, or repair authority by editing JSON manually.

When the user explicitly closes a milestone and says they will continue in a
fresh chat, and the current task is quiescent, the factual Terra root executes:

`node .codex/astra-orchestra/session-handoff-cli.mjs prepare --boundary`

Do not ask the user to run that command, copy a session ID, or edit runtime
state in the normal flow. Do not arm a handoff merely because a task reached
`DONE`; explicit user intent to move chats is required.

The next fresh trusted `SessionStart` claims the single-use boundary lease
automatically. A successful boundary resets task authority to `INTAKE` and
does not migrate the prior Scope Contract, Evidence Ledger, workers, retries,
transcript, prompts, reasoning, or model summaries. The former root must stop;
future prompts and supported project-tool calls from it are blocked by the
provider-native session hooks.

Milestone O implements milestone-boundary transfer only. Do not improvise a
mid-task `LIVE_CONTINUATION`; use provider-native continuation semantics until
a separate Orchestra trust contract exists for that mode.

Project hooks remain subject to Codex hook trust. Use the provider's normal
review/approval flow when trust is requested; never make bypassing hook trust
part of the normal Orchestra workflow.

## Native parity boundaries

Codex uses its own provider-native Orchestra modules under
`.codex/astra-orchestra/`; never import Antigravity operational code from
`.agents/**` or `runtimes/antigravity/**`.

- `requiredEvidence` is first-class Scope Contract state. Only factual,
  attempt/mutation-bound evidence may satisfy it. Worker prose and feedback
  declarations never count as evidence.
- `trust-boundary.mjs` classifies side effects. Remote repository writes,
  network writes and publication are default-deny unless the Scope Contract
  explicitly carries the matching capability or a narrowly classified Direct
  Action grants it.
- `context-packet.mjs` preserves the mandatory governance core and sends
  bounded references for auxiliary context. Raw transcripts, prompts,
  reasoning, stdout/stderr dumps, credentials and unrelated history are not
  packet inputs.
- `dream-lab.mjs` is offline/shadow only. Dream records have
  `authority=NONE`; Canary requires explicit human approval and may not
  rewrite routing source or activate itself.
- `feedback-plane.mjs` records hypotheses/experiments as attributable
  metadata. It cannot self-promote a model claim into factual evidence.
- `mechanical-fast-path.mjs` permits only bounded Luna Medium support work
  outside sensitive runtime/security paths.
- `evidence-watch-runner.mjs` advances remote-CI watches from factual
  provider observations supplied by the Codex session or connector. It does
  not own credentials or create a background polling daemon.

Provider-native transcript/context management remains provider-owned. Orchestra
may persist bounded factual sidecars under `.codex/orchestra-state/`,
`.codex/orchestra-telemetry/`, `.codex/orchestra-artifacts/`, and
`.codex/orchestra-semantic/`; never copy raw provider transcripts or hidden
reasoning into those stores.
