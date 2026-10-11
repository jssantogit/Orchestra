function metric(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function summarizeDirectWorkEconomy(values = {}) {
  return Object.freeze({
    lane: values.lane ?? null,
    control_turns: metric(values.control_turns),
    worker_turns: metric(values.worker_turns),
    repository_discovery_ops: metric(values.repository_discovery_ops),
    redundant_reads: metric(values.redundant_reads),
    turns_to_first_edit: metric(values.turns_to_first_edit),
    delegations: metric(values.delegations),
    model_handoffs: metric(values.model_handoffs),
    quick_audit_invocations: metric(values.quick_audit_invocations),
    candidate_generations: metric(values.candidate_generations),
    approximate_cost: metric(values.approximate_cost),
  });
}
