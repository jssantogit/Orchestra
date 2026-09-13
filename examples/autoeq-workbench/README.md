# Example: AutoEQ Workbench Multi-Agent Setup

This example demonstrates how Orchestra was applied to **AutoEQ Workbench**, a real-world project featuring digital signal processing (DSP), numerical optimization algorithms, and a React web application.

---

## 1. Domain Specialization

AutoEQ Workbench required strict isolation between its pure numerical DSP library and its visual frontend. It extended Orchestra's default domains with two custom domains:

| Domain | Scope | Description |
| :--- | :--- | :--- |
| `DSP_CORE` | `packages/core/**` | Mathematical DSP filters, biquads, normalization, parser |
| `AUTOEQ_ALGORITHM` | `packages/core/src/autoeq/**` | Numerical optimization, solver calibration, curve fitting |
| `UI` | `apps/web/**` | React components, UI state, interactive curve canvas |
| `TESTING` | `packages/core/tests/**` | Deterministic unit tests and benchmarks |

### Customizing Domains in Codex Policy:
```javascript
import { registerCustomDomains } from "./routing-policy.mjs";

registerCustomDomains([
  "AUTOEQ_ALGORITHM",
  "DSP_CORE"
]);
```

---

## 2. Path Boundaries & Scope Contracts

To prevent agents from accidentally importing React into pure DSP algorithms or modifying reference fixtures, the scope contract enforced:

```json
{
  "taskAction": "IMPLEMENT",
  "taskDomain": "DSP_CORE",
  "allowedPaths": ["packages/core/src/dsp/**"],
  "forbiddenPaths": ["apps/web/**", "vendor/**", "docs/**"],
  "acceptanceCriteria": ["DSP filter math matches reference curve within 0.01 dB"],
  "requiredValidation": ["pnpm --filter @autoeq-workbench/core test"],
  "retryBudget": 2
}
```

---

## 3. Two-Key Review for Critical Mathematical Code

Any modifications touching core filter math were flagged as `criticality: CRITICAL`, triggering Two-Key independent review by two Flash High reviewers before acceptance.

---

## 4. Example Files Included

- `codex-config.example.toml` — Project-scoped Codex configuration template.
- `AGENTS.example.md` — Project guidance preserving research fixtures and forbidding UI imports into core.
