import test from 'node:test';
import assert from 'node:assert/strict';

import { DIRECT_WORK_PROBES } from '../../benchmarks/turn-economy/probes.mjs';
import { summarizeDirectWorkEconomy } from '../../benchmarks/turn-economy/direct-work-metrics.mjs';
import { normalizeTurnEconomyMetrics } from '../../benchmarks/turn-economy/turn-analysis.mjs';

test('Direct Work benchmark exposes the four representative promotion probes', () => {
  assert.deepEqual(
    DIRECT_WORK_PROBES.map((probe) => probe.scenario),
    [
      'BOUNDED_BUG_FIX',
      'AUTHORIZED_REGRESSION_TEST_CHANGE',
      'UNRELATED_EXTERNAL_TEST_FAILURE',
      'QUICK_AUDIT_DELTA_RETRY',
    ],
  );

  for (const probe of DIRECT_WORK_PROBES) {
    assert.match(probe.probeId, /^direct-work-/);
    assert.equal(typeof probe.name, 'string');
    assert.ok(probe.name.length > 0);
    assert.equal(typeof probe.prompt, 'string');
    assert.ok(probe.prompt.length > 0);
  }
});

test('Direct Work economy summary uses the canonical turn-economy vocabulary', () => {
  const normalized = normalizeTurnEconomyMetrics({
    control_turns: 1,
    worker_turns: 2,
    repository_discovery_ops: 1,
    redundant_reads: 0,
    turns_to_first_edit: 1,
    delegations: 2,
    model_handoffs: 2,
    approximate_cost: null,
  });

  const summary = summarizeDirectWorkEconomy({
    lane: 'DIRECT_WORK',
    ...normalized,
    quick_audit_invocations: 1,
    candidate_generations: 1,
  });

  assert.deepEqual(summary, {
    lane: 'DIRECT_WORK',
    control_turns: 1,
    worker_turns: 2,
    repository_discovery_ops: 1,
    redundant_reads: 0,
    turns_to_first_edit: 1,
    delegations: 2,
    model_handoffs: 2,
    quick_audit_invocations: 1,
    candidate_generations: 1,
    approximate_cost: null,
  });
});
