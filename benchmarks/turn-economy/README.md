# TURN ECONOMY BENCHMARK v1: Codex vs Antigravity

## Overview

The Turn Economy Benchmark evaluates model turn efficiency, tool call density, and context consumption across two agent orchestration runtimes:
- **Codex Runtime**: Terra control plane + Luna workers + Sol review (OpenAI models).
- **Antigravity Runtime**: Gemini 3.8 Flash Medium orchestrator + Flash Low/Medium/High workers + Two-Key Flash High reviewers (Google DeepMind Gemini models).

The primary objective is to investigate the **Model Turn Amplification** hypothesis: whether the Antigravity runtime uses more inferences and context replay per task, resulting in higher quota/token consumption despite using efficient Flash models.

## Structure

```
benchmarks/turn-economy/
├── fixture/                       # Provider-neutral synthetic calculator/parser project
│   ├── src/                       # Source modules (calculator, parser, formatter)
│   ├── test/                      # Test suites (node --test)
│   └── package.json
├── raw/                           # Raw JSONL / transcript outputs (gitignored)
├── results/
│   └── summary.json               # Sanitized comparative metrics summary
├── run.mjs                        # Cross-platform benchmark runner
└── README.md                      # This document
```

## Tasks in Suite

1. **TASK 1 — DIRECT STATUS (`status`)**
   - Prompt: `"Show the current git status concisely. Do not modify anything."`
   - Goal: Measure minimal Direct Action overhead (0 subagents, zero writes, minimal tool turns).
2. **TASK 2 — TARGETED LOOKUP (`lookup`)**
   - Prompt: `"Find where numeric input validation is implemented and tell me what values are rejected. Do not modify anything."`
   - Goal: Measure search, read, and inspection behavior without writes.
3. **TASK 3 — SIMPLE IMPLEMENTATION (`simple`)**
   - Prompt: `"Fix the formatter bug where negative values lose their sign. Add or update the focused test and validate the change."`
   - Goal: Measure single-file implementation, handoff, and test validation.
4. **TASK 4 — NORMAL MULTI-FILE IMPLEMENTATION (`multi`)**
   - Prompt: `"Add support for an optional precision argument to number formatting. Keep the existing default behavior unchanged, update the parser/formatter boundary as needed, and add focused tests."`
   - Goal: Measure multi-file coordination, handoff contracts, and acceptance verification.
5. **TASK 5 — INVESTIGATION (`investigation`)**
   - Prompt: `"A test around parsed percentage values is failing intermittently. Investigate the root cause, identify the smallest correct fix, implement it, and validate the affected behavior."`
   - Goal: Measure root-cause analysis vs code implementation.
6. **TASK 6 — CRITICAL REVIEW (`critical`, Optional)**
   - Prompt: `"CRITICAL: Conduct an independent Two-Key critical review of the security boundaries."`
   - Goal: Compare Sol independent review vs AGY Two-Key independent consensus.

## Metrics & Observability

### Real Tokens vs. Proxies (Hardened v1)

| Metric | Codex Runtime | Antigravity Runtime | Classification | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `input_tokens` | Exact (`turn.completed`) | Exact (`agy` JSON output) | `ACCUMULATED_COUNTER` | Session prompt tokens reported by runtime |
| `cached_input_tokens` | Exact (`turn.completed`) | `PROVIDER_SPECIFIC` | `ACCUMULATED_COUNTER` / `PROVIDER_SPECIFIC` | In Codex: guaranteed subset of input. In AGY: independent Gemini context cache counter |
| `uncached_input_tokens`| `DERIVED_COUNTER` | `NOT_DERIVABLE` (`null`) | `DERIVED_COUNTER` / `NOT_DERIVABLE` | AGY strictly rejects `input - cached` to prevent negative token counts |
| `output_tokens` | Exact (`turn.completed`) | Exact (`agy` JSON output) | `ACCUMULATED_COUNTER` | Completion / candidate tokens |
| `reasoning_tokens` | Exact (`reasoning_output_tokens`) | Exact (`thinking_tokens`) | `ACCUMULATED_COUNTER` | Subset of output tokens dedicated to reasoning |
| `model_turns_total` | Exact (JSONL) | Exact (`PreInvocation` hook / transcript) | `DIRECT_COUNTER` | Distinct model inferences dispatched |
| `tool_calls` | Exact (JSONL items) | Exact (`PostToolUse` hook) | `DIRECT_COUNTER` | Total tool operations dispatched |
| `subagent_invocations` | Exact (events) | Exact (`invoke_subagent` hook) | `DIRECT_COUNTER` | Subagent instances spawned |
| `forced_stop_continuations`| N/A | Exact (`Stop` hook) | `DIRECT_COUNTER` | Turns forced back by Stop Guard |
| `advisory_injections` | N/A | Exact (`PreInvocation` hook) | `DIRECT_COUNTER` | Ephemeral system advisories entered into context |
| `jev_calls` | Optional lab metric | Optional lab metric | `DIRECT_COUNTER` | Jev semantic-ranking requests; zero in normal runtime unless shadow telemetry exists |
| `jev_latency_ms` | Optional lab metric | Optional lab metric | `ACCUMULATED_COUNTER` | Total Jev request latency |
| `jev_candidates` | Optional lab metric | Optional lab metric | `DIRECT_COUNTER` | Deterministically generated candidates considered for semantic ranking |
| `jev_ranked_items` | Optional lab metric | Optional lab metric | `DIRECT_COUNTER` | Candidate items scored by Jev |
| `jev_candidate_bytes` / `jev_selected_bytes` | Optional lab metric | Optional lab metric | `DIRECT_COUNTER` | Counterfactual auxiliary-context bytes before/after ranking |
| `potential_context_reduction` | Optional lab metric | Optional lab metric | `DERIVED_COUNTER` | Counterfactual reduction only; never treated as realized provider token savings |
| `future_use_recall_at_k` | Optional lab metric | Optional lab metric | `DERIVED_COUNTER` | Recall against later factual references |
| `critical_reference_recall` | Optional lab metric | Optional lab metric | `DERIVED_COUNTER` | Recall for pinned/critical references; required to remain 1.0 for activation |
| `false_low_relevance` | Optional lab metric | Optional lab metric | `DERIVED_COUNTER` | Fraction of future-used items Jev scored at or below the low-relevance threshold |

## Formal Definition of Model Turn

- **Antigravity Runtime**: A `MODEL_TURN` is defined as a single discrete model inference triggered by the runtime. Observably, it starts at the `PreInvocation` hook and corresponds to one `PLANNER_RESPONSE` step with `source: "MODEL"`. It consumes the current accumulated prompt context and produces either a terminal textual response (0 tools) or one or more tool calls ($N \ge 1$). Only after all tool calls dispatched in that turn have completed does the next model turn begin.
- **Codex Runtime**: In `codex exec --json --ephemeral`, Codex packages the execution into an outer macro-turn bounded by `turn.started` and `turn.completed`. While multiple tool execution items (`command_execution`, `apply_patch`) occur inside that macro-turn, `model_invocations` reported in the CLI JSONL counts the outer turn with accumulated usage.

## Token & Cache Semantics Hardening

### The Task 3 Token Anomaly Explained
In Task 3, AGY reported `input_tokens = 166,925` and `cache_read_tokens = 223,111`, with `total_tokens = 173,236` ($166,925 + 6,311$).
- In Google Gemini API usage metadata, `totalTokenCount = promptTokenCount + candidatesTokenCount`. `cachedContentTokenCount` is an independent counter that records cache hits across turns and is **not included in promptTokenCount**.
- The naive formula `uncached = input_tokens - cached_input_tokens` assumed cache hits were a subset of `input_tokens`, resulting in $166,925 - 223,111 = -56,186$, which previously clamped silently to $0$.
- Under Hardened v1, `uncached_input_tokens` for AGY is explicitly marked `null` with status `NOT_DERIVABLE` to preserve mathematical integrity and prevent corrupted accounting.

## Multi-Tool Capability & Findings

Empirical capability probes (`probe-a-two-reads`, `probe-b-search-read`, `probe-c-parallel-read`, `probe-worker-delegation`) revealed:
1. **NATIVE_MULTI_TOOL_SUPPORTED**: Antigravity runtime natively supports multiple parallel tool calls emitted in a single model turn. Probe A and Probe C executed two independent `view_file` calls in Turn 1 ($[2, 0]$ distribution, 2 model turns total).
2. **Sequential Data Dependencies**: When tools require feedback (e.g. `grep_search` to find a symbol followed by `view_file` to inspect the implementation), execution is inherently serialized across multiple model turns ($[1, 1, 1, 1, 0]$ in Probe B).
3. **Task 3 Subagent Reality**: Task 3 had 0 subagent invocations because the main agent executed all reading, editing, and validation directly without delegating to `flash-worker`. This was an operational choice by the main agent, not a telemetry hook omission.

## Capability Matrix

The consolidated capability matrix is versioned at [`results/capability-matrix.json`](file:///C:/Projects/Orchestra/benchmarks/turn-economy/results/capability-matrix.json).
The hardened baseline is versioned at [`results/hardened-baseline.json`](file:///C:/Projects/Orchestra/benchmarks/turn-economy/results/hardened-baseline.json).

## Execution Safety & Quota Warning

> [!WARNING]
> Live runs execute actual model API calls and consume quota.
> Always run `--dry-run` first before dispatching live runs.
> Follow the multi-stage checkpointing plan:
> - **Checkpoint 1**: Task 1 (Status) on Codex and AGY.
> - **Checkpoint 2**: Task 2 and Task 3, verifying remaining quota.
> Stop with `BENCHMARK_PARTIAL` if quota is depleted.

## Usage

### 1. Deterministic Dry Run (Zero Quota Consumption)
```bash
node benchmarks/turn-economy/run.mjs --dry-run --all
```

### 2. Single Task Live Run
```bash
# Checkpoint 1: Run Task 1 on both runtimes
node benchmarks/turn-economy/run.mjs --task status

# Run on specific runtime only
node benchmarks/turn-economy/run.mjs --runtime codex --task status
node benchmarks/turn-economy/run.mjs --runtime antigravity --task status
```

### 3. Automated Test Verification
```bash
npm run test:turn-economy
```

### 4. Jev Semantic Counterfactual Evaluation

No Jev call is made during the normal Turn Economy suite.

```bash
# Offline deterministic/fake Jev evaluation across status/lookup/simple/multi/investigation/critical.
npm run benchmark:jev

# Live shadow evaluation against TypeSafe Jev; sends only bounded synthetic candidate metadata.
TYPESAFE_API_KEY=... npm run benchmark:jev -- --live
```

The Jev suite evaluates semantic relevance and future-use recall. It does not alter runtime behavior and does not count counterfactual byte reduction as realized token savings.
