# Repository Guidance: AutoEQ Workbench Example

## Scope & Non-Destruction

- Make the smallest coherent project change that satisfies the approved task.
- Preserve unrelated local WIP, research artifacts, scratch files, and experiment outputs.
- Never run destructive git commands (`git clean`, `git reset --hard`, destructive checkouts).

## Architecture Boundaries

- Keep DSP, parsing, normalization, metrics, optimization, and quantization in `packages/core`.
- Keep `packages/core` framework-agnostic; never import React, Zustand, or Tailwind CSS into core.
- `vendor/squiglink/` is immutable reference material and must never be modified or runtime-imported.

## Verification

- Run focused tests for changed behavior:
  `pnpm --filter @autoeq-workbench/core test`
- For browser/session changes, run browser checks.
