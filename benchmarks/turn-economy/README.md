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

### Real Tokens vs. Proxies

| Metric | Codex Runtime | Antigravity Runtime | Notes |
| :--- | :--- | :--- | :--- |
| `input_tokens` | Exact (JSONL) | `NOT_AVAILABLE` | AGY CLI does not expose live token counts in print mode |
| `cached_input_tokens` | Exact (JSONL) | `NOT_AVAILABLE` | Provided natively by Codex |
| `output_tokens` | Exact (JSONL) | `NOT_AVAILABLE` | Provided natively by Codex |
| `reasoning_tokens` | Exact (JSONL) | `NOT_AVAILABLE` | Extracted from `reasoning_output_tokens` |
| `context_proxy_bytes` | Calculated | Exact byte count | Size of prompts, tool inputs, outputs, and injected state |
| `model_invocations` | Exact (JSONL) | Exact (`PreInvocation` hook) | Count of model inferences |
| `tool_calls` | Exact (JSONL) | Exact (`PostToolUse` hook) | Total tool turns dispatched |
| `subagent_invocations` | Exact (events) | Exact (`invoke_subagent`) | Subagent instances spawned |
| `forced_stop_continuations`| N/A | Exact (`Stop` hook) | Turns forced back by Stop Guard |
| `advisory_injections` | N/A | Exact (`PreInvocation` hook) | Ephemeral system advisories entered into context |

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
