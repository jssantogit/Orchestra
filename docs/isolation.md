# Cross-Runtime Isolation & Firewall

Orchestra hosts two independent multi-agent runtimes:
1. **Codex Runtime**: Built for OpenAI models (Terra / Luna / Sol / Astra).
2. **Antigravity Runtime**: Built for Gemini models (Flash Low / Medium / High).

---

## 1. The Isolation Invariant

- **Zero Mixing of Control Planes**: The Codex control plane runs exclusively on OpenAI models and has no runtime dependencies on Antigravity hooks, state files, or Gemini workers.
- **Zero Mixing of Agent Models**: Antigravity routing never selects GPT models or falls back to external providers.
- **Shared Concepts, Not Shared Coupling**: Principles, contracts, and handoff formats are shared conceptually in `shared/`, but neither runtime imports the other's operational code.

---

## 2. Cross-Runtime Firewall Testing

To permanently prevent accidental provider mixing, Orchestra maintains automated firewall tests in `tests/cross-runtime/cross-runtime-firewall.test.mjs` and `scripts/contamination-check.mjs`:

- **Codex Active Runtime Scan**:
  - Scans `.codex/config.toml`, `.codex/hooks.json`, `.codex/astra-orchestra/INSTRUCTIONS.md`, every active `.codex/astra-orchestra/*.mjs` module, and `.codex/agents/*.toml`.
  - Asserts zero active imports or routes matching `gemini-`, `flash-worker`, `flash-orchestrator`, or `ALL-GEMINI`.
- **Antigravity Active Runtime Scan**:
  - Scans active routing definitions in `.agents/skills/orchestra/routing-policy.mjs` and agent definitions in `.agents/agents/*.md`.
  - Asserts zero active routes selecting `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.6-sol`, or `gpt-6-astra`.

---

## 3. Privacy & Secret Safeguards

- Antigravity operational state (`.agents/state/`, `.agents/telemetry/`, `.agents/artifacts/`) is excluded from version control via `.gitignore`.
- Codex project-owned state (`.codex/orchestra-state/`, `.codex/orchestra-telemetry/`, `.codex/orchestra-artifacts/`, `.codex/orchestra-semantic/`, and runtime-management data) is likewise excluded.
- Raw session JSONL transcripts, token traces, and private user credentials must never be committed.
- Pre-commit scanning verifies that local absolute paths (`/root/`, `/home/`, Android storage paths) and sensitive tokens are absent from the repository.

---

## 4. External Semantic Services

Optional semantic services such as TypeSafe AI Jev are **not runtimes** and are not eligible model routes.

- Codex remains OpenAI-only.
- Antigravity remains Gemini-only.
- Jev may exist only in provider-neutral experiment/benchmark code unless a later human-gated retrieval-assist activation is explicitly approved.
- Active routing, worker/reviewer profiles, hooks, Evidence Ledger, Stop Guard and Dream execution source must not import or select Jev.
- Cross-runtime tests and the contamination checker reject `jev-latest`, TypeSafe endpoint/key references, and imports from `experiments/jev` inside active runtime files.

This preserves the distinction between a control-plane model provider and a zero-authority semantic ranking service.


---

## 5. Codex Native Parity Boundary

Milestone M implements Evidence, Feedback, Trust, Context Packet, Mechanical
Fast Path, Dream Lab, and project-runtime lifecycle as **Codex-local modules**
under `.codex/astra-orchestra/`.

They may preserve common Orchestra schemas and semantics, but must not import
Antigravity implementation files. This is enforced both by architecture tests
and by the contamination scanner.

Runtime state namespaces are also disjoint:

- Codex: `.codex/orchestra-*/`
- Antigravity: `.agents/state/`, `.agents/telemetry/`,
  `.agents/artifacts/`, `.agents/semantic/`, and `.agents/dream-data/`

An update to one runtime therefore cannot overwrite the other runtime's control
plane or project-owned state.
