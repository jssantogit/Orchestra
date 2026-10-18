# Orchestra v2 Provider Field-Test Runbook

Status: execution protocol for V2-11 cutover evidence.

This runbook produces factual cutover evidence for Codex and Antigravity. It does not authorize merge, tag, publish, production cutover, or v1 removal.

## Preconditions

Before running any provider scenario, freeze and record:

- the exact 40-character Git head under test;
- the exact installed/pinned Runtime Image ID;
- the registered Project lineage ID;
- the Orchestra Home used by the global control plane;
- the provider family and factual provider version;
- a project that has completed the approved migration/cleanup path so no project-local v2 governance brain remains.

Do not continue from an ambiguous or partially migrated Project. `UNKNOWN`, unavailable command/event evidence, unresolved stale state, or a runtime/head mismatch is a failed field-evidence set, not a reason to infer success.

## Required scenarios

Run all six scenarios independently for **Codex** and **Antigravity** on the same exact head/runtime pair being evaluated.

### 1. `ACTIVE_WORK_ATTACH`

1. Start or identify a current v2 Work Unit for the registered Project.
2. Start a fresh provider session/conversation.
3. Let the provider's thin transport shim report the factual provider identity.
4. Exercise the official attach/authority path.
5. Record the factual result proving the provider attached to the current Work without conversation ownership.

Success requires the official result to bind the provider observation to the registered Project, current Work, current generation and current instruction epoch.

### 2. `NO_ACTIVE_WORK_INTAKE`

1. Use a registered Project with no current Work Unit.
2. Start a fresh provider session/conversation.
3. Exercise the official session/attach path.
4. Record the factual result proving the system enters the no-active-work / INTAKE boundary rather than inventing Work or inheriting another conversation's authority.

### 3. `MUTATION_TERMINALIZATION`

1. Establish a current Work Unit.
2. Execute one real, bounded provider mutation through the official v2 authorization path.
3. Capture the factual Operation begin result.
4. Capture the factual terminalization result after the provider event completes.
5. Verify the terminal Operation is bound to the expected Project, Work and generation.

Do not classify provider output text as terminalization evidence; use the official durable Operation result.

### 4. `STALE_EPOCH_DENIAL`

1. Establish a provider observation at the current instruction epoch.
2. Perform the official runtime pin/upgrade operation so the Project instruction epoch advances.
3. Reuse the old provider observation for a mutation attempt.
4. Record the official denial, expected to resolve through the v2 stale-runtime/epoch fence (for example `SESSION_RUNTIME_STALE`).

A manual timestamp comparison or operator assertion is not sufficient.

### 5. `OWNER_LOSS_RECOVERY`

1. Begin one factual mutation Operation with a runtime owner or provider-event liveness fact.
2. Make the owner factually disappear, or allow its bounded deadline to expire, without clean terminalization.
3. Run the official Project status/reconciliation path.
4. Record the factual stale/unknown classification and the required recovery action.
5. Run the official recovery/dirty-resolution path when recovery is factually available.
6. Record the durable terminal/recovery result.

Persisted `RUNNING`/`LIVE` is never itself liveness proof. If the owner cannot be disproved or the workspace identity is unresolved, record failure/unknown rather than success.

### 6. `THIN_SHIM_ONLY`

1. Inspect the migrated Project's provider integration surface after cleanup.
2. Verify the remaining project-local files are transport/configuration shims only.
3. Verify the shim points to the global Orchestra launcher/control plane.
4. Verify no copied `v2/**` governance runtime, project-local authority brain, or stale v1 authority hook remains.
5. Record the factual inspection result.

## Evidence record

Each scenario emits one `orchestra.cutover-field-evidence.v2` record with `version: 1` and these fields only:

```json
{
  "schema": "orchestra.cutover-field-evidence.v2",
  "version": 1,
  "provider": {
    "family": "codex",
    "version": "<factual-provider-version>"
  },
  "project": {
    "lineageId": "<registered-lineage-id>"
  },
  "runtimeImageId": "<exact-runtime-image-id>",
  "headSha": "<exact-40-character-git-sha>",
  "scenarioId": "ACTIVE_WORK_ATTACH",
  "factualResult": {
    "ok": true,
    "code": "<FACT_CLASS>",
    "factRef": "evidence:<sanitized-reference>"
  },
  "terminalStatus": "VERIFIED",
  "observedAt": "<ISO-8601 UTC timestamp>",
  "evidenceRefs": [
    "sha256:<digest>"
  ],
  "operatorAttestation": {
    "subjectHash": "sha256:<operator-subject-digest>",
    "attestedAt": "<ISO-8601 UTC timestamp>"
  }
}
```

`operatorAttestation` is provenance only. It cannot replace a factual command/event result and cannot turn `FAILED` or `UNKNOWN` into `VERIFIED`.

## Privacy and sanitization boundary

Store references and normalized facts, not raw provider/project content. Field evidence must not contain:

- prompts or transcripts;
- raw provider logs;
- provider session/conversation IDs;
- source code, diffs or patches;
- tokens, secrets or credentials;
- hidden reasoning;
- arbitrary artifact bytes.

Hash or project provider/user identifiers before they reach the record. If a useful fact cannot be represented without raw private content, keep it outside the global field-evidence record and store only an approved sanitized reference/digest.

## Acceptance

For each provider family, the cutover evaluator must receive exactly the complete scenario set:

1. `ACTIVE_WORK_ATTACH`
2. `NO_ACTIVE_WORK_INTAKE`
3. `MUTATION_TERMINALIZATION`
4. `STALE_EPOCH_DENIAL`
5. `OWNER_LOSS_RECOVERY`
6. `THIN_SHIM_ONLY`

Every record must match the exact head and Runtime Image ID under evaluation, validate against the closed schema, contain a factual successful result, and terminate as `VERIFIED`.

Missing, duplicate, malformed, stale-head, stale-runtime, `FAILED`, or `UNKNOWN` records keep provider field readiness false. A green CI run alone is not a substitute for these real provider field results.

After both provider sets are complete, attach their sanitized evidence references to the V2-11 readiness record/PR. Stop before merge, release or production cutover unless the operator explicitly authorizes that next action.
