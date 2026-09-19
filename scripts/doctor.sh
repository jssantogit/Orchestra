#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=================================================="
echo " Orchestra Repository Doctor"
echo "=================================================="
echo "Checking repository health at: ${ROOT_DIR}"
echo ""

FAILURES=0

report_pass() {
  echo " [PASS] $1"
}

report_fail() {
  echo " [FAIL] $1"
  FAILURES=$((FAILURES + 1))
}

# 1. Required Meta Files
REQUIRED_META_FILES=(
  "README.md"
  "LICENSE"
  "SECURITY.md"
  "CONTRIBUTING.md"
  "AGENTS.md"
  ".gitignore"
)

for file in "${REQUIRED_META_FILES[@]}"; do
  if [ -f "${ROOT_DIR}/${file}" ]; then
    report_pass "Meta file present: ${file}"
  else
    report_fail "Missing required meta file: ${file}"
  fi
done

# 2. Required Codex Runtime Files
REQUIRED_CODEX_FILES=(
  "runtimes/codex/.codex/config.toml"
  "runtimes/codex/.codex/astra-orchestra/INSTRUCTIONS.md"
  "runtimes/codex/.codex/astra-orchestra/routing-policy.mjs"
  "runtimes/codex/.codex/astra-orchestra/routing-policy.test.mjs"
  "runtimes/codex/.codex/astra-orchestra/evidence-provider-registry.mjs"
  "runtimes/codex/.codex/astra-orchestra/evidence-watch.mjs"
  "runtimes/codex/.codex/astra-orchestra/evidence-contract.mjs"
  "runtimes/codex/.codex/astra-orchestra/evidence-federation.mjs"
  "runtimes/codex/.codex/astra-orchestra/evidence-collectors.mjs"
  "runtimes/codex/.codex/astra-orchestra/evidence-watch-runner.mjs"
  "runtimes/codex/.codex/astra-orchestra/feedback-plane.mjs"
  "runtimes/codex/.codex/astra-orchestra/trust-boundary.mjs"
  "runtimes/codex/.codex/astra-orchestra/mechanical-fast-path.mjs"
  "runtimes/codex/.codex/astra-orchestra/context-packet.mjs"
  "runtimes/codex/.codex/astra-orchestra/dream-lab.mjs"
  "runtimes/codex/.codex/astra-orchestra/codex-runtime-manager.mjs"
  "runtimes/codex/.codex/astra-orchestra/codex-runtime-cli.mjs"
  "runtimes/codex/tests/parity.test.mjs"
  "scripts/orchestra-codex-project.mjs"
  "runtimes/codex/.codex/agents/luna-high.toml"
  "runtimes/codex/.codex/agents/luna-medium.toml"
  "runtimes/codex/.codex/agents/luna-max.toml"
  "runtimes/codex/.codex/agents/terra-high.toml"
  "runtimes/codex/.codex/agents/terra-xhigh.toml"
  "runtimes/codex/.codex/agents/terra-max.toml"
  "runtimes/codex/.codex/agents/sol-low.toml"
  "runtimes/codex/.codex/agents/sol-medium.toml"
  "runtimes/codex/.codex/agents/astra-manual.toml"
)

for file in "${REQUIRED_CODEX_FILES[@]}"; do
  if [ -f "${ROOT_DIR}/${file}" ]; then
    report_pass "Codex runtime file present: ${file}"
  else
    report_fail "Missing Codex file: ${file}"
  fi
done

# 3. Required Antigravity Runtime Files
REQUIRED_AGY_FILES=(
  "runtimes/antigravity/.agents/hooks.json"
  "runtimes/antigravity/.agents/agents/flash-orchestrator.md"
  "runtimes/antigravity/.agents/agents/flash-low-worker.md"
  "runtimes/antigravity/.agents/agents/flash-medium-worker.md"
  "runtimes/antigravity/.agents/agents/flash-worker.md"
  "runtimes/antigravity/.agents/agents/flash-reviewer.md"
  "runtimes/antigravity/.agents/agents/flash-policy-designer.md"
  "runtimes/antigravity/.agents/dream/policy-lab.mjs"
  "runtimes/antigravity/.agents/dream/policy-lab-cli.mjs"
  "runtimes/antigravity/.agents/dream/shadow-mode.mjs"
  "runtimes/antigravity/.agents/dream/shadow-cli.mjs"
  "runtimes/antigravity/.agents/dream/canary-mode.mjs"
  "runtimes/antigravity/.agents/dream/canary-rollout.mjs"
  "runtimes/antigravity/.agents/dream/canary-cli.mjs"
  "runtimes/antigravity/.agents/dream/policy-store.mjs"
  "runtimes/antigravity/.agents/dream/exploration-governance.mjs"
  "runtimes/antigravity/.agents/dream/full-exploration.mjs"
  "runtimes/antigravity/.agents/dream/full-exploration-cli.mjs"
  "experiments/jev/schemas.mjs"
  "experiments/jev/client.mjs"
  "experiments/jev/outbound-projector.mjs"
  "experiments/jev/catalog-builder.mjs"
  "experiments/jev/candidate-generator.mjs"
  "experiments/jev/artifact-ranker.mjs"
  "experiments/jev/future-use-oracle.mjs"
  "experiments/jev/redundancy-shadow.mjs"
  "experiments/jev/evaluator.mjs"
  "experiments/jev/packet-builder.mjs"
  "experiments/jev/activation-gate.mjs"
  "experiments/jev/retrieval-assist.mjs"
  "experiments/jev/dream-analyzer.mjs"
  "experiments/jev/egress-policy.mjs"
  "experiments/jev/shadow-runner.mjs"
  "experiments/jev/jev-cli.mjs"
  "runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs"
  "runtimes/antigravity/.agents/hooks/pre-tool-side-effect-guard.mjs"
  "runtimes/antigravity/.agents/hooks/post-tool-telemetry.mjs"
  "runtimes/antigravity/.agents/hooks/pre-invocation-guard.mjs"
  "runtimes/antigravity/.agents/hooks/stop-guard.mjs"
  "runtimes/antigravity/.agents/hooks/output-gate-runner.mjs"
  "runtimes/antigravity/.agents/hooks/verify-batch.mjs"
  "runtimes/antigravity/.agents/hooks/git-operation.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/SKILL.md"
  "runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/evidence-contract.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/evidence-collectors.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/evidence-federation.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/evidence-inspector.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/evidence-provider-registry.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/evidence-watch.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/evidence-watch-runner.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/project-runtime-manager.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/project-runtime-cli.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/mechanical-fast-path.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/feedback-plane.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/trust-boundary.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/routing-policy.test.mjs"
  "runtimes/antigravity/GEMINI.md"
)

for file in "${REQUIRED_AGY_FILES[@]}"; do
  if [ -f "${ROOT_DIR}/${file}" ]; then
    report_pass "Antigravity runtime file present: ${file}"
  else
    report_fail "Missing Antigravity file: ${file}"
  fi
done

# 4. Syntax Checks on Node.js Scripts
JS_FILES=(
  "runtimes/codex/.codex/astra-orchestra/routing-policy.mjs"
  "runtimes/codex/.codex/astra-orchestra/evidence-provider-registry.mjs"
  "runtimes/codex/.codex/astra-orchestra/evidence-watch.mjs"
  "runtimes/codex/.codex/astra-orchestra/evidence-contract.mjs"
  "runtimes/codex/.codex/astra-orchestra/evidence-federation.mjs"
  "runtimes/codex/.codex/astra-orchestra/evidence-collectors.mjs"
  "runtimes/codex/.codex/astra-orchestra/evidence-watch-runner.mjs"
  "runtimes/codex/.codex/astra-orchestra/feedback-plane.mjs"
  "runtimes/codex/.codex/astra-orchestra/trust-boundary.mjs"
  "runtimes/codex/.codex/astra-orchestra/mechanical-fast-path.mjs"
  "runtimes/codex/.codex/astra-orchestra/context-packet.mjs"
  "runtimes/codex/.codex/astra-orchestra/dream-lab.mjs"
  "runtimes/codex/.codex/astra-orchestra/codex-runtime-manager.mjs"
  "runtimes/codex/.codex/astra-orchestra/codex-runtime-cli.mjs"
  "scripts/orchestra-codex-project.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/routing-policy.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/evidence-contract.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/evidence-collectors.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/evidence-federation.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/project-runtime-manager.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/project-runtime-cli.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/mechanical-fast-path.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/feedback-plane.mjs"
  "runtimes/antigravity/.agents/skills/orchestra/trust-boundary.mjs"
  "scripts/orchestra-project.mjs"
  "scripts/install-antigravity.mjs"
  "runtimes/antigravity/.agents/hooks/pre-tool-enforce.mjs"
  "runtimes/antigravity/.agents/hooks/pre-tool-side-effect-guard.mjs"
  "runtimes/antigravity/.agents/hooks/post-tool-telemetry.mjs"
  "runtimes/antigravity/.agents/hooks/pre-invocation-guard.mjs"
  "runtimes/antigravity/.agents/hooks/stop-guard.mjs"
  "runtimes/antigravity/.agents/hooks/output-gate-runner.mjs"
  "runtimes/antigravity/.agents/hooks/verify-batch.mjs"
  "runtimes/antigravity/.agents/hooks/git-operation.mjs"
  "runtimes/antigravity/.agents/dream/policy-lab.mjs"
  "runtimes/antigravity/.agents/dream/policy-lab-cli.mjs"
  "runtimes/antigravity/.agents/dream/shadow-mode.mjs"
  "runtimes/antigravity/.agents/dream/shadow-cli.mjs"
  "runtimes/antigravity/.agents/dream/canary-mode.mjs"
  "runtimes/antigravity/.agents/dream/canary-rollout.mjs"
  "runtimes/antigravity/.agents/dream/canary-cli.mjs"
  "runtimes/antigravity/.agents/dream/policy-store.mjs"
  "runtimes/antigravity/.agents/dream/exploration-governance.mjs"
  "runtimes/antigravity/.agents/dream/full-exploration.mjs"
  "runtimes/antigravity/.agents/dream/full-exploration-cli.mjs"
  "experiments/jev/schemas.mjs"
  "experiments/jev/client.mjs"
  "experiments/jev/outbound-projector.mjs"
  "experiments/jev/catalog-builder.mjs"
  "experiments/jev/candidate-generator.mjs"
  "experiments/jev/artifact-ranker.mjs"
  "experiments/jev/future-use-oracle.mjs"
  "experiments/jev/redundancy-shadow.mjs"
  "experiments/jev/evaluator.mjs"
  "experiments/jev/packet-builder.mjs"
  "experiments/jev/activation-gate.mjs"
  "experiments/jev/retrieval-assist.mjs"
  "experiments/jev/dream-analyzer.mjs"
  "experiments/jev/egress-policy.mjs"
  "experiments/jev/shadow-runner.mjs"
  "experiments/jev/jev-cli.mjs"
  "benchmarks/turn-economy/jev-evaluation.mjs"
  "scripts/contamination-check.mjs"
)

for js in "${JS_FILES[@]}"; do
  if node --check "${ROOT_DIR}/${js}" 2>/dev/null; then
    report_pass "Syntax valid: ${js}"
  else
    report_fail "Syntax error in: ${js}"
  fi
done

# 5. Clean State Verification (No committed runtime state)
STATE_FILES=$(find "${ROOT_DIR}/runtimes/antigravity/.agents/state" -maxdepth 1 -type f ! -name ".gitkeep" 2>/dev/null || true)
if [ -z "${STATE_FILES}" ]; then
  report_pass "Runtime state directory is clean (.agents/state/ contains no leaked state)"
else
  report_fail "Runtime state leaked: ${STATE_FILES}"
fi

TELEMETRY_FILES=$(find "${ROOT_DIR}/runtimes/antigravity/.agents/telemetry" -maxdepth 1 -type f ! -name ".gitkeep" 2>/dev/null || true)
if [ -z "${TELEMETRY_FILES}" ]; then
  report_pass "Runtime telemetry directory is clean (.agents/telemetry/ contains no leaked events)"
else
  report_fail "Runtime telemetry leaked: ${TELEMETRY_FILES}"
fi

# 6. Run Cross-Runtime Contamination Check
if node "${ROOT_DIR}/scripts/contamination-check.mjs" >/dev/null 2>&1; then
  report_pass "Cross-runtime contamination check passed"
else
  report_fail "Cross-runtime contamination check failed"
fi

# 7. Run Deterministic Tests
echo ""
echo "Running deterministic test verification..."

if node --test "${ROOT_DIR}/runtimes/codex/tests/routing-policy.test.mjs" >/dev/null 2>&1; then
  report_pass "Codex deterministic routing policy tests passed"
else
  report_fail "Codex routing policy tests failed"
fi

if node --test "${ROOT_DIR}/runtimes/codex/tests/parity.test.mjs" >/dev/null 2>&1; then
  report_pass "Codex runtime parity tests passed"
else
  report_fail "Codex runtime parity tests failed"
fi

if node --test "${ROOT_DIR}/tests/installers/codex-project-runtime-manager.test.mjs" >/dev/null 2>&1; then
  report_pass "Codex project runtime lifecycle tests passed"
else
  report_fail "Codex project runtime lifecycle tests failed"
fi

if node --test "${ROOT_DIR}/runtimes/antigravity/tests/routing-policy.test.mjs" >/dev/null 2>&1; then
  report_pass "Antigravity deterministic routing policy tests passed"
else
  report_fail "Antigravity routing policy tests failed"
fi

if node --test "${ROOT_DIR}/tests/evidence/first-class-evidence.test.mjs" "${ROOT_DIR}/tests/evidence/cross-agent-evidence.test.mjs" "${ROOT_DIR}/tests/evidence/evidence-observability.test.mjs" "${ROOT_DIR}/tests/evidence/evidence-provider-watch.test.mjs"; then
  report_pass "Evidence contract, federation, observability, and provider-watch tests passed"
else
  report_fail "Evidence contract/federation/observability/provider-watch tests failed"
fi

if node --test "${ROOT_DIR}/tests/mechanical/mechanical-fast-path.test.mjs"; then
  report_pass "Mechanical fast-path tests passed"
else
  report_fail "Mechanical fast-path tests failed"
fi

if node --test "${ROOT_DIR}/tests/feedback/feedback-plane.test.mjs" "${ROOT_DIR}/tests/trust/trust-boundary.test.mjs" "${ROOT_DIR}/tests/exploration/full-exploration.test.mjs"; then
  report_pass "Milestones I-J-K feedback, trust, and full-exploration tests passed"
else
  report_fail "Milestones I-J-K tests failed"
fi

if node --test "${ROOT_DIR}/tests/jev/jev-contract.test.mjs" "${ROOT_DIR}/tests/jev/jev-shadow.test.mjs" "${ROOT_DIR}/tests/jev/future-use-oracle.test.mjs" "${ROOT_DIR}/tests/jev/turn-economy-jev.test.mjs" "${ROOT_DIR}/tests/jev/turn-economy-metrics.test.mjs"; then
  report_pass "Milestone L Jev semantic shadow tests passed"
else
  report_fail "Milestone L Jev semantic shadow tests failed"
fi

if node --test "${ROOT_DIR}/tests/cross-runtime/cross-runtime-firewall.test.mjs" >/dev/null 2>&1; then
  report_pass "Cross-runtime firewall tests passed"
else
  report_fail "Cross-runtime firewall tests failed"
fi

echo ""
if [ "${FAILURES}" -eq 0 ]; then
  echo "Doctor Status: HEALTHY. All checks passed successfully."
  exit 0
else
  echo "Doctor Status: UNHEALTHY. ${FAILURES} check(s) failed."
  exit 1
fi
