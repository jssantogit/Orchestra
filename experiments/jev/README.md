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
# Shadow first records only the prediction.
npm run jev:lab -- shadow --repo /path/to/project --goal "current goal"

# After factual future runtime telemetry exists, append exactly one label for that prediction.
# The CLI reads .agents/telemetry/events.jsonl after the Shadow timestamp; it does not accept model-supplied future-event files.
npm run jev:lab -- label --repo /path/to/project \
  --shadow-id <jev-shadow-id>

# Evaluation uses only report+label pairs and persists a hash-bound report.
npm run jev:lab -- evaluate --repo /path/to/project
npm run jev:lab -- dream --repo /path/to/project

# Live shadow only; sends sanitized projection metadata to TypeSafe.
TYPESAFE_API_KEY=... npm run jev:lab -- shadow --repo /path/to/turn-economy-fixture --goal "..." --live
```

## Retrieval Assist

The implementation exists but is not wired into either runtime.

To become active it requires:
- enough **post-hoc labeled** Shadow runs; unlabeled predictions never count as quality evidence;
- an eligible factual evaluation report persisted under `.agents/semantic/jev-evaluation.json`;
- telemetry unchanged since that report was generated;
- explicit local human approval tied to both the report hash and telemetry hash;
- `ORCHESTRA_JEV_RETRIEVAL_ASSIST=1`.

Reports/labels are append-only observations: a Shadow prediction can be labeled once. Malformed telemetry fails closed.

If any condition fails, `buildRetrievalAssistedPacket()` returns the original mandatory packet unchanged.

## Data egress

The outbound projector rejects raw-content fields such as stdout/stderr/body/content/transcript/messages/prompt/reasoning/secrets. Candidate summaries are bounded and secret-redacted. Absolute paths are excluded.

Live egress is automatically allowed only for `benchmarks/turn-economy/fixture`. A real project additionally requires the explicit local opt-in `ORCHESTRA_JEV_ALLOW_PROJECT_EGRESS=1`; `--live` alone is insufficient.

## Dream

Dream worlds are immutable. Jev analysis is written only as sidecars under:

```text
.agents/dream-data/jev-annotations/
```

A Jev score is never a Dream fact or policy outcome.
