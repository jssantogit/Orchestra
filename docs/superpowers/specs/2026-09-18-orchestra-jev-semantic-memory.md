# Orchestra Jev Semantic Memory — Milestone L

## Decision

Jev is an optional semantic decision service for **priority only**.

It MUST NOT:
- rewrite, delete, compact, or replace the provider transcript;
- substitute provider-native compaction or reasoning state;
- delete Orchestra evidence, artifacts, telemetry, worlds, mutations, or state;
- satisfy Evidence Contracts;
- change Scope Contracts, routing, retries, state transitions, acceptance, Human Gates, security rules, or Cross-Runtime Firewall behavior;
- become a Codex or Antigravity model route, worker, reviewer, fallback, or control plane.

The permanent rule is:

> Determinism for authority. Jev for priority. Provider-native management for transcript. Orchestra factual memory for truth.

## Architecture

```text
provider transcript
  -> provider-native context management only

Orchestra factual memory
  -> deterministic candidate generation
  -> bounded outbound projection
  -> optional Jev semantic reranking
  -> deterministic selection policy
  -> original factual rehydration by ID/path
  -> existing Output Gate / packet budgets
```

Jev never transports evidence. A Jev score is `SEMANTIC_RANK` with `authority=NONE`.

## Phases

- **L0 Contract** — schemas, egress policy, metrics and invariants.
- **L1 Offline Jev Lab** — artifact catalog + deterministic candidate generator + fake/live client.
- **L2 Redundancy Oracle** — shadow probability that a proposed read/search/validation adds new information.
- **L3 Dream Semantic Analysis** — immutable world sidecars only; worlds are never modified.
- **L4 Counterfactual Packet Builder** — build Jev-assisted auxiliary context without delivering it.
- **L5 Live Shadow** — run Jev during benchmark tasks, telemetry only.
- **L6 Retrieval Assist** — code path exists but is fail-closed until a factual benchmark report and explicit local human approval match.
- **L7 Broader Ranking** — search/reviewer auxiliary references may use the same gate after approval.
- **Never** — transcript pruning, evidence deletion, acceptance/routing/tool-denial authority.

## Candidate pipeline

Candidate generation is deterministic and bounded before Jev.

Candidate identity is content-addressed. Candidate metadata may include factual identifiers such as artifact path, evidence ID, execution ID, task ID, mutation sequence, kind, byte size, result class and a bounded factual summary.

Raw artifact bodies, raw stdout, transcripts, prompts, secrets, credentials, private Dream history and arbitrary active-state objects are not valid outbound projection fields.

## Egress

The Jev HTTP client accepts only `orchestra.jev-projection.v1`. It does not accept raw Orchestra state.

The default live endpoint is `https://api.typesafe.ai/v1/systemone`, model `jev-latest`, API key `TYPESAFE_API_KEY`.

Live calls are allowed only when the caller explicitly requests live mode. Runtime integration remains absent until Retrieval Assist activation is approved.

## Retrieval Assist gate

Active packet influence requires all of:
1. a factual Jev evaluation report;
2. minimum sample coverage;
3. critical reference recall of 1.0;
4. future-use recall >= 0.95;
5. false-low-relevance <= 0.02;
6. no increase in tool re-execution;
7. no acceptance/fidelity regression;
8. explicit local human approval whose report hash matches the factual report;
9. `ORCHESTRA_JEV_RETRIEVAL_ASSIST=1`.

Failure of any condition returns the current deterministic Orchestra packet unchanged.

## Cross-runtime isolation

Jev is not a runtime provider. It is an optional semantic service outside both control planes.

Active routing files MUST NOT contain a Jev model route. Runtime profiles MUST NOT select `jev-*` or TypeSafe. The experiments layer may mention Jev freely.

## Evaluation objective

Do not optimize raw token reduction.

Primary question:

> Does Jev predict future factual usefulness and redundancy well enough to improve auxiliary retrieval without reducing critical-reference recall, increasing tool re-execution, reducing acceptance quality, or perturbing provider-native context management?

