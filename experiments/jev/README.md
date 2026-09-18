# Jev Semantic Shadow Lab

This directory experiments with TypeSafe AI Jev as a **semantic ranking service with zero Orchestra authority**.

## Non-goals

Jev never:
- edits the provider transcript;
- replaces native compaction;
- deletes evidence, artifacts, telemetry, mutations or Dream worlds;
- accepts/rejects work;
- changes Scope Contracts, routing, retries, Human Gates or tool permissions;
- blocks tool calls;
- appears as a Codex/Antigravity worker, reviewer, fallback or model route.

## Pipeline

```text
factual external memory
 -> deterministic catalog
 -> deterministic candidate generator (<=64)
 -> outbound projector (bounded/sanitized)
 -> Jev semantic scores
 -> deterministic top-K / byte budget
 -> counterfactual packet / shadow telemetry
```

The HTTP client accepts only `orchestra.jev-projection.v1`.

## Commands

```bash
npm run jev:lab -- catalog --repo /path/to/project
npm run jev:lab -- shadow --repo /path/to/project --goal "current goal"
npm run jev:lab -- evaluate --repo /path/to/project
npm run jev:lab -- dream --repo /path/to/project

# Live shadow only; sends sanitized projection metadata to TypeSafe.
TYPESAFE_API_KEY=... npm run jev:lab -- shadow --repo /path/to/turn-economy-fixture --goal "..." --live
```

## Retrieval Assist

The implementation exists but is not wired into either runtime.

To become active it requires:
- an eligible factual evaluation report;
- explicit local human approval tied to the report hash;
- `ORCHESTRA_JEV_RETRIEVAL_ASSIST=1`.

If any condition fails, `buildRetrievalAssistedPacket()` returns the original mandatory packet unchanged.

## Data egress

The outbound projector rejects raw-content fields such as stdout/stderr/body/content/transcript/messages/prompt/reasoning/secrets. Candidate summaries are bounded and secret-redacted. Absolute paths are excluded.

For first live evaluation, use only `benchmarks/turn-economy/fixture`, not a private project.

## Dream

Dream worlds are immutable. Jev analysis is written only as sidecars under:

```text
.agents/dream-data/jev-annotations/
```

A Jev score is never a Dream fact or policy outcome.
