# Orchestra First-Class Evidence Architecture — CI-first + Mechanical Evidence

Status: DESIGN ONLY  
Date: 2026-09-18  
Source: first real Tsuzuki dogfooding after Dream A-H completion

## 1. Problem statement

The current runtime conflates "acceptance evidence" with "a local validation command executed by a WORK child".

That assumption breaks valid CI-first projects and creates unnecessary HUMAN_GATE transitions for simple deterministic checks.

Two consecutive Tsuzuki tasks demonstrated the same structural mismatch:

- authoritative GitHub Actions Fast CI completed successfully for the exact implementation commit;
- the local Scope Contract either still contained a Gradle command or contained only a non-validation git command;
- `verifyWorkerValidation()` could not recognize the remote CI result;
- Stop Guard emitted `EVIDENCE_MISSING`;
- a second identical blocked stop escalated to `STOP_GUARD_STALLED -> HUMAN_GATE`.

A separate mechanical task exposed the companion bug:

- a worker created/modified the correct file;
- the required fact was mechanically checkable (for example file existence or git-ignore behavior);
- the WORK child was allowed to terminate before the required proof existed in Evidence Ledger;
- parent acceptance later discovered the missing evidence and stalled.

The fail-closed principle is correct. The evidence model is too narrow.

## 2. Current architecture findings

### 2.1 Scope Contract can only express command-oriented validation

`pre-tool-enforce.mjs::extractScopeContractFromPrompt()` currently normalizes:

- `allowedPaths`
- `forbiddenPaths`
- `testsRequired`

The implementation contract stores `testsRequired` and has no generic first-class `requiredEvidence` representation.

Natural-language statements such as "GitHub Fast CI is authoritative" do not create a structured acceptance requirement.

### 2.2 Evidence Ledger is populated primarily from local execution

`post-tool-telemetry.mjs` consumes factual execution records and calls
`classifyExecutionEvidence()`.

Current classes include:

- TEST_RUN
- TYPECHECK
- BUILD
- LINT
- BENCHMARK
- SCOPE_CHECK
- GIT_OPERATION
- GENERIC_COMMAND_RESULT

Evidence is then attributed to the factual actor and mutation sequence.

This is useful provenance, but it assumes the proof originated as a local tool execution.

### 2.3 `git status` is evidence data but not validation evidence

`classifyExecutionEvidence()` labels `git status` as `GIT_OPERATION`.

`isValidationCommand()` accepts test/typecheck/lint/build and `git diff --check`, but not `git status`.

Therefore a successful `git status` does not satisfy the current validation gate.

This behavior is internally consistent; the problem is that the acceptance contract has no way to say that GIT_STATE is the required evidence class.

### 2.4 `verifyWorkerValidation()` hardcodes local WORK-child semantics

The verifier:

- reads `testsRequired`;
- searches Evidence Ledger by command string / test type;
- requires fresh evidence for the current mutation sequence and retry attempt;
- requires actor role WORKER;
- requires HIGH factual identity;
- requires WORK delegation;
- if no specific tests are configured, still requires at least one valid local TEST_RUN.

Therefore remote CI can never satisfy acceptance, regardless of how trustworthy it is.

### 2.5 Stop Guard has a single boolean validation gate

Parent acceptance currently requires:

`completionClaimed && valEval.verified && noScopeViolation && noUnresolvedWrites && twoKeyGate.satisfied`

Any unsatisfied validation is collapsed into `EVIDENCE_MISSING`.

Two identical blocked stops become `STOP_GUARD_STALLED -> HUMAN_GATE`.

The runtime cannot currently distinguish:

- evidence still running remotely;
- evidence deterministically failed;
- evidence stale;
- evidence can be collected mechanically now;
- worker omitted an actionable local validation;
- evidence source unavailable;
- contract invalid.

### 2.6 CI_WAIT does not exist in the state machine

Current state machine has:

INTAKE, CLASSIFIED, DIRECT_ACTION, PLANNED, DELEGATED, EXECUTING,
EVIDENCE_READY, ACCEPTANCE, INTEGRATING, CRITICAL_REVIEW, DONE, BLOCKED,
HUMAN_GATE.

There is no first-class waiting state for an authoritative asynchronous validator.

### 2.7 WORK children terminate before acceptance evidence is checked

In `stop-guard.mjs`, a factual child Stop is finalized and returned before the
parent-side call to `verifyWorkerValidation()`.

Consequences:

- a WORK child may claim completion and terminate without required local proof;
- the missing proof becomes the parent's problem;
- the parent can only loop/recontact/replan and eventually hit HUMAN_GATE.

This caused the earlier mechanical `.gitignore` failure mode.

### 2.8 There is no remote-CI collector in Orchestra today

No current runtime code queries GitHub Actions or records provider-verified CI
evidence. Existing CI information can only enter as model text or generic local
tool output, neither of which should be authoritative.

## 3. Confirmed GitHub Actions evidence surface

The real Tsuzuki Fast CI runs provide all required binding fields directly from
GitHub's API:

- repository full name;
- workflow ID;
- workflow name;
- workflow file path;
- run ID;
- run attempt;
- event;
- head commit SHA;
- head branch;
- run status;
- run conclusion;
- individual job names;
- individual job status/conclusion;
- job head SHA.

This means a deterministic runtime collector can verify CI without parsing model
text and without trusting an arbitrary URL.

## 4. Design principle

Replace:

> acceptance evidence == local worker validation command

with:

> acceptance evidence == a set of typed, provenance-verified, freshness-bound
> Evidence Requirements satisfied by factual Evidence Records.

The invariant remains:

MODEL CLAIM IS NOT EVIDENCE.

The new invariant is:

VERIFIED RUNTIME OR PROVIDER FACT IS EVIDENCE.

## 5. Evidence Requirement model

Add `requiredEvidence` to Scope Contract.

Example CI-first contract:

```json
{
  "allowedPaths": ["..."],
  "forbiddenPaths": [".agents/**"],
  "requiredEvidence": [
    {
      "id": "fast-ci",
      "class": "FAST_CI",
      "kind": "REMOTE_CI",
      "provider": "GITHUB_ACTIONS",
      "workflow": {
        "id": 360365122,
        "path": ".github/workflows/ci.yml"
      },
      "requiredJobs": [
        "Format",
        "Kotlin Compile",
        "Unit Tests",
        "SQLDelight Migrations"
      ],
      "bind": {
        "repository": "CURRENT_ORIGIN",
        "commit": "CURRENT_HEAD",
        "task": true,
        "attempt": true
      }
    }
  ]
}
```

Example mechanical contract:

```json
{
  "requiredEvidence": [
    {
      "id": "plan-file",
      "class": "FILE_EXISTS",
      "kind": "LOCAL_FACT",
      "path": "docs/superpowers/plans/example.md"
    }
  ]
}
```

Legacy `testsRequired` remains supported and is internally normalized into
typed LOCAL_COMMAND / LOCAL_TEST requirements.

No natural-language "CI-first" phrase grants authority. The structured contract
is authoritative.

## 6. Evidence Record model

Introduce a normalized first-class record shape, conceptually:

```json
{
  "schema": "orchestra.evidence.v1",
  "evidenceId": "...",
  "requirementId": "fast-ci",
  "class": "FAST_CI",
  "kind": "REMOTE_CI",
  "result": "PASS",
  "provider": "GITHUB_ACTIONS",
  "repository": "jssantogit/mihon",
  "workflow": {
    "id": 360365122,
    "name": "Fast CI",
    "path": ".github/workflows/ci.yml"
  },
  "run": {
    "id": 35368076713,
    "attempt": 1,
    "headSha": "da380a41ddf36718ab47022d26446d3206d65af3",
    "headBranch": "tsuzuki/mvp-v1-catalog-kitsu-search-discover",
    "status": "completed",
    "conclusion": "success"
  },
  "jobs": [
    {"name": "Format", "conclusion": "success"},
    {"name": "Kotlin Compile", "conclusion": "success"},
    {"name": "Unit Tests", "conclusion": "success"},
    {"name": "SQLDelight Migrations", "conclusion": "success"}
  ],
  "binding": {
    "taskId": "...",
    "attempt": 0,
    "commitSha": "da380...",
    "mutationSeq": 12
  },
  "provenance": {
    "source": "ORCHESTRA_GITHUB_COLLECTOR",
    "observedAt": "..."
  }
}
```

Important distinctions:

- `class` says what contractual proof this satisfies;
- `kind` says how it was obtained;
- `result` carries PASS / FAIL / PENDING;
- provider facts are stored structurally;
- model-authored messages never create Evidence Records.

## 7. Generic Evidence Collectors

Add a small collector layer independent of Stop Guard.

Initial collectors:

### 7.1 LOCAL_COMMAND

Existing factual execution evidence.

Covers:

- LOCAL_TEST
- LOCAL_BUILD
- LOCAL_TYPECHECK
- LOCAL_LINT
- SCOPE_CHECK

Existing `classifyExecutionEvidence()` remains useful and should feed the
normalized record shape.

### 7.2 GITHUB_ACTIONS

Read-only provider collector.

It MUST verify:

1. repository is the factual `origin` repository;
2. workflow ID/path matches the contract;
3. run belongs to the factual current HEAD commit;
4. run branch/ref matches the factual branch when required;
5. run is for the allowed event;
6. all required jobs exist;
7. every required job belongs to the same SHA;
8. every required job completed successfully;
9. run itself completed successfully;
10. no tracked product mutation exists after the commit being validated.

A user/model-provided run ID may be used only as a lookup hint. It never bypasses
the bindings above.

Collector implementation should be provider-adapter based, not embedded in
Stop Guard. GitHub can initially use a deterministic read-only API adapter.
Authentication failure / provider unavailability is not PASS.

### 7.3 LOCAL_FACT

Runtime-owned deterministic checks, initially:

- FILE_EXISTS
- FILE_NOT_EXISTS
- EXPECTED_FILE_MODIFIED
- GIT_CLEAN / GIT_STATE
- HEAD_SHA
- BRANCH_REF
- SCOPE_CHECK

These facts are collected directly by Orchestra, not by requiring a worker to
run `test -f` or `git status` merely so a shell event exists.

This solves the mechanical-evidence bug without special cases in Stop Guard.

## 8. Contract verifier

Introduce a generic verifier, e.g. `verifyEvidenceContract()`.

It returns a structured state rather than one boolean:

- SATISFIED
- PENDING
- FAILED
- MISSING_ACTIONABLE
- STALE
- SOURCE_UNAVAILABLE
- INVALID_CONTRACT

Each requirement returns its own result and evidence reference.

Legacy `verifyWorkerValidation()` becomes a compatibility wrapper or is
internally implemented through this verifier.

Acceptance checks the contract verifier, not the actor role of a single local
test command.

Actor/provenance rules remain requirement-specific:

- LOCAL_COMMAND can require factual WORK identity;
- REMOTE_CI requires factual runtime/provider collector provenance;
- LOCAL_FACT requires factual Orchestra runtime provenance.

## 9. CI_WAIT state

Add `CI_WAIT` as a real state.

Minimum transitions:

- EXECUTING -> CI_WAIT
- EVIDENCE_READY -> CI_WAIT
- CI_WAIT -> CI_WAIT
- CI_WAIT -> EVIDENCE_READY
- CI_WAIT -> PLANNED
- CI_WAIT -> BLOCKED
- CI_WAIT -> HUMAN_GATE

Semantics:

### CI still running

- collector records PENDING;
- state becomes CI_WAIT;
- Stop Guard returns a wait/continue diagnostic;
- `stopBlockedCount` is NOT incremented;
- this is not EVIDENCE_MISSING;
- existing polling/backoff limits apply.

### CI success

- PASS evidence is written;
- state transitions CI_WAIT -> EVIDENCE_READY -> ACCEPTANCE -> DONE.

### CI failure

- FAIL evidence is written;
- if retry budget remains: set a dedicated remote-validation retry reason and
  route through Delta Retry;
- if retry budget is exhausted: BLOCKED;
- deterministic CI failure should not become HUMAN_GATE merely because it
  repeated.

### CI source unavailable / provenance ambiguous

Fail closed. Persistent inability to establish authoritative evidence may
eventually require HUMAN_GATE, but it is distinct from CI failure and from CI
still running.

## 10. Freshness and stale-run protection

Remote CI PASS is valid only for the exact candidate being accepted.

At minimum bind to:

- repository;
- workflow;
- current HEAD SHA;
- task ID when available;
- retry attempt;
- current mutation sequence;
- clean tracked workspace relative to HEAD.

Any subsequent product mutation invalidates the CI evidence.

A green run for an earlier commit is STALE, never reusable acceptance evidence.

## 11. Child completion evidence lock

Fix the earlier WORK-child lifecycle bug.

Before a factual WORK child is allowed to terminate successfully:

1. sync factual child evidence;
2. evaluate only requirements that the child is responsible for producing;
3. if a required local command is missing but actionable, return `continue` to
   the SAME child with the exact missing requirement;
4. do not finalize the delegated decision outcome yet;
5. when child-owned requirements are satisfied, permit child Stop.

Runtime-owned requirements do not keep the worker alive:

- FILE_EXISTS can be collected by Orchestra immediately;
- REMOTE_CI is collected after commit/push and moves the parent to CI_WAIT.

This changes:

worker stops -> parent discovers missing command -> HUMAN_GATE

into:

worker claims complete -> child Stop checks local obligation -> same worker
runs missing check -> child closes -> parent handles runtime/remote evidence.

## 12. Mechanical-task fast path

Do not weaken separation of duties.

MECHANICAL_FIX continues to use `flash-low-worker` for workspace changes.

But its lifecycle becomes:

Orchestrator -> flash-low-worker -> bounded edit -> runtime mechanical evidence
collector -> parent acceptance -> DONE.

It MUST NOT require a full test suite when the structured evidence contract only
requires deterministic mechanical facts.

It MUST NOT invent investigation/review steps.

This addresses the ".gitignore became a giant workflow" problem while retaining
worker-only product/workspace mutation authority.

## 13. Stop Guard behavior after the change

Stop Guard should no longer branch on only `valEval.verified`.

It consumes the generic verifier result:

- SATISFIED -> normal acceptance logic;
- PENDING remote -> CI_WAIT, no stall counter;
- MISSING_ACTIONABLE child-local -> keep factual child alive;
- FAILED -> Delta Retry / BLOCKED;
- STALE -> recollect/re-run the declared evidence;
- SOURCE_UNAVAILABLE -> fail closed with bounded recovery;
- INVALID_CONTRACT -> HUMAN_GATE / BLOCKED depending whether deterministic
  repair is possible.

`MODEL CLAIM IS NOT EVIDENCE` remains in force.

## 14. Minimal implementation surface

Expected behavior changes should be concentrated in:

1. `routing-policy.mjs`
   - evidence classes / normalizer / generic verifier;
   - CI_WAIT state;
   - retry reason for remote validation failure.

2. `pre-tool-enforce.mjs`
   - extract/validate structured `requiredEvidence`;
   - preserve legacy `testsRequired` compatibility.

3. new `evidence-collectors.mjs`
   - local fact collectors;
   - GitHub Actions collector;
   - evidence record validation/provenance.

4. `post-tool-telemetry.mjs`
   - normalize local execution facts into first-class evidence records.

5. `stop-guard.mjs`
   - child completion evidence lock;
   - generic verifier;
   - CI_WAIT / failure routing;
   - remove false equivalence between every unsatisfied requirement and
     `EVIDENCE_MISSING`.

6. tests
   - regression fixtures from both real Tsuzuki failures;
   - mechanical FILE_EXISTS / git-state case;
   - stale commit;
   - wrong repository;
   - wrong workflow;
   - missing required job;
   - running CI;
   - failed/cancelled/skipped CI;
   - provider/model claim cannot forge evidence;
   - child cannot terminate with missing actionable local evidence;
   - legacy local-test behavior unchanged.

No Dream A-H policy authority needs to be weakened.

## 15. Explicit non-goals

This change does NOT:

- accept CI because the model says it passed;
- skip evidence checks for CI-first projects;
- make arbitrary URLs authoritative;
- accept a successful run from another commit/repository/workflow;
- make all local validation optional;
- allow the orchestrator or worker to write Evidence Ledger directly;
- remove Stop Guard;
- remove fail-closed behavior;
- make GitHub Actions a hard-coded universal acceptance provider.

## 16. Acceptance criteria

The architecture is complete when all of the following hold:

1. A CI-first task with only FAST_CI required can reach DONE with zero local
   Gradle validation.
2. The exact successful Fast CI run for the current commit satisfies acceptance.
3. A run for a prior commit is rejected as STALE.
4. Running CI produces CI_WAIT, not EVIDENCE_MISSING.
5. Failed CI creates factual failure evidence and routes to Delta Retry or
   BLOCKED.
6. Missing required jobs cannot satisfy the contract.
7. Model text claiming "CI green" cannot satisfy the contract.
8. FILE_EXISTS can be satisfied by a runtime collector without requiring
   `test -f`.
9. A WORK child missing an explicitly required local command cannot terminate
   and dump the problem onto the parent.
10. Legacy local validation tests continue to pass unchanged.
11. Existing Scope, Two-Key, Canary, Dream and contamination invariants remain
    green.
12. The Tsuzuki Task 1 and Task 2 failure modes are reproduced by regression
    tests and then pass under the new architecture.
