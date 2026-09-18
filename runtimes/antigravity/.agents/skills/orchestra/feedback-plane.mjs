import { createHash } from "node:crypto";

export const FEEDBACK_SCHEMA = "orchestra.feedback-plane.v1";
export const FEEDBACK_DECLARATION_MARKER = "ORCHESTRA_FEEDBACK_V1:";

export const FEEDBACK_KINDS = Object.freeze({
  HYPOTHESIS: "HYPOTHESIS",
  EXPERIMENT: "EXPERIMENT",
  OBSERVATION: "OBSERVATION",
  FEEDBACK: "FEEDBACK",
});

export const FEEDBACK_STATUS = Object.freeze({
  UNKNOWN: "UNKNOWN",
  OBSERVED: "OBSERVED",
  SUPPORTED: "SUPPORTED",
  FALSIFIED: "FALSIFIED",
  CAUSALLY_VERIFIED: "CAUSALLY_VERIFIED",
});

const INTERPRETATIONS = new Set(["SUPPORTS", "FALSIFIES", "OBSERVES_ONLY"]);
const DESIGNS = new Set(["OBSERVATIONAL", "MUTATION_AB"]);

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
}

export function feedbackHash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function recordId(prefix, body) {
  return `${prefix}-${feedbackHash(body).slice(0, 24)}`;
}

function factualEvidenceId(ev = {}) {
  return ev.id || ev.evidenceId || ev.executionId || null;
}

function evidenceResult(ev = {}) {
  if (typeof ev.exitCode === "number") return ev.exitCode === 0 ? "PASS" : "FAIL";
  const token = cleanString(ev.result || ev.status || ev.outcome).toUpperCase();
  if (["PASS", "PASSED", "SUCCESS", "SUCCEEDED", "GREEN"].includes(token)) return "PASS";
  if (["FAIL", "FAILED", "FAILURE", "ERROR", "RED"].includes(token)) return "FAIL";
  return "UNKNOWN";
}

function evidenceMutationSeq(ev = {}) {
  const value = ev.mutationSeq ?? ev.mutation_seq ?? ev.binding?.mutationSeq ?? ev.binding?.mutation_seq;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function evidenceAttempt(ev = {}) {
  const value = ev.attempt ?? ev.binding?.attempt;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function evidenceCommand(ev = {}) {
  return cleanString(ev.command || ev.binding?.command);
}

function evidenceIsFactual(ev = {}) {
  const id = factualEvidenceId(ev);
  const result = evidenceResult(ev);
  if (!id || result === "UNKNOWN") return false;
  if (ev.confidence && cleanString(ev.confidence).toUpperCase() === "LOW") return false;
  if (ev.provisional === true || ev.factual === false) return false;
  return true;
}

export function extractFeedbackDeclarations(message) {
  const text = typeof message === "string" ? message : JSON.stringify(message || "");
  const declarations = [];
  const errors = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const idx = rawLine.indexOf(FEEDBACK_DECLARATION_MARKER);
    if (idx < 0) continue;
    const json = rawLine.slice(idx + FEEDBACK_DECLARATION_MARKER.length).trim();
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) declarations.push(...parsed);
      else declarations.push(parsed);
    } catch {
      errors.push("MALFORMED_FEEDBACK_DECLARATION");
    }
  }
  return { declarations, errors };
}

export function validateFeedbackDeclaration(raw = {}) {
  const type = cleanString(raw.type || raw.kind).toUpperCase();
  const errors = [];
  if (!["HYPOTHESIS", "EXPERIMENT"].includes(type)) errors.push("UNSUPPORTED_DECLARATION_TYPE");

  if (type === "HYPOTHESIS") {
    if (!cleanString(raw.key || raw.hypothesis_key)) errors.push("HYPOTHESIS_KEY_REQUIRED");
    if (!cleanString(raw.statement)) errors.push("HYPOTHESIS_STATEMENT_REQUIRED");
    if (!cleanString(raw.falsifier || raw.falsifiable_by)) errors.push("HYPOTHESIS_FALSIFIER_REQUIRED");
  }

  if (type === "EXPERIMENT") {
    if (!cleanString(raw.key || raw.experiment_key)) errors.push("EXPERIMENT_KEY_REQUIRED");
    if (!cleanString(raw.hypothesis_key)) errors.push("EXPERIMENT_HYPOTHESIS_KEY_REQUIRED");
    if (!cleanString(raw.command)) errors.push("EXPERIMENT_COMMAND_REQUIRED");
    const design = cleanString(raw.design || "OBSERVATIONAL").toUpperCase();
    if (!DESIGNS.has(design)) errors.push("EXPERIMENT_DESIGN_INVALID");
    const pass = cleanString(raw.pass_interpretation || "OBSERVES_ONLY").toUpperCase();
    const fail = cleanString(raw.fail_interpretation || "OBSERVES_ONLY").toUpperCase();
    if (!INTERPRETATIONS.has(pass) || !INTERPRETATIONS.has(fail)) errors.push("EXPERIMENT_INTERPRETATION_INVALID");
  }

  return { valid: errors.length === 0, type, errors };
}

function ensureFeedbackState(activeState) {
  if (!activeState.feedbackPlane || activeState.feedbackPlane.schema !== FEEDBACK_SCHEMA) {
    activeState.feedbackPlane = {
      schema: FEEDBACK_SCHEMA,
      hypotheses: [],
      experiments: [],
      observations: [],
      feedback: [],
      aliases: { hypotheses: {}, experiments: {} },
      declarationErrors: [],
    };
  }
  return activeState.feedbackPlane;
}

function actorPacket(context = {}) {
  return {
    actor_id: context.actorId || context.conversationId || null,
    role: context.role || "UNKNOWN",
    source: context.source || "UNRESOLVED",
    confidence: context.confidence || "LOW",
  };
}

export function applyFeedbackDeclarations(activeState, rawDeclarations = [], context = {}) {
  const plane = ensureFeedbackState(activeState);
  const taskId = context.taskId || activeState.taskId || null;
  const attempt = Number.isInteger(context.attempt) ? context.attempt : (activeState.attempt || 0);
  const mutationSeq = Number.isInteger(context.mutationSeq) ? context.mutationSeq : (activeState.mutationSeq || 0);
  let accepted = 0;

  for (const raw of rawDeclarations) {
    const validation = validateFeedbackDeclaration(raw);
    if (!validation.valid) {
      plane.declarationErrors.push({ errors: validation.errors, observed_at: new Date().toISOString() });
      continue;
    }

    if (validation.type === "HYPOTHESIS") {
      const key = cleanString(raw.key || raw.hypothesis_key);
      if (plane.aliases.hypotheses[key]) continue;
      const body = {
        schema: FEEDBACK_SCHEMA,
        kind: FEEDBACK_KINDS.HYPOTHESIS,
        task_id: taskId,
        attempt,
        mutation_seq_declared: mutationSeq,
        key,
        statement: cleanString(raw.statement),
        falsifier: cleanString(raw.falsifier || raw.falsifiable_by),
        target_paths: Array.isArray(raw.target_paths) ? raw.target_paths.map(cleanString).filter(Boolean).sort() : [],
        actor: actorPacket(context),
      };
      const record = { ...body, hypothesis_id: recordId("hyp", body), declared_at: new Date().toISOString() };
      plane.hypotheses.push(record);
      plane.aliases.hypotheses[key] = record.hypothesis_id;
      accepted += 1;
      continue;
    }

    const key = cleanString(raw.key || raw.experiment_key);
    if (plane.aliases.experiments[key]) continue;
    const hypothesisId = plane.aliases.hypotheses[cleanString(raw.hypothesis_key)];
    if (!hypothesisId) {
      plane.declarationErrors.push({ errors: ["UNKNOWN_HYPOTHESIS_KEY"], experiment_key: key, observed_at: new Date().toISOString() });
      continue;
    }
    const body = {
      schema: FEEDBACK_SCHEMA,
      kind: FEEDBACK_KINDS.EXPERIMENT,
      task_id: taskId,
      attempt,
      mutation_seq_declared: mutationSeq,
      key,
      hypothesis_id: hypothesisId,
      command: cleanString(raw.command),
      design: cleanString(raw.design || "OBSERVATIONAL").toUpperCase(),
      pass_interpretation: cleanString(raw.pass_interpretation || "OBSERVES_ONLY").toUpperCase(),
      fail_interpretation: cleanString(raw.fail_interpretation || "OBSERVES_ONLY").toUpperCase(),
      actor: actorPacket(context),
    };
    const record = { ...body, experiment_id: recordId("exp", body), declared_at: new Date().toISOString() };
    plane.experiments.push(record);
    plane.aliases.experiments[key] = record.experiment_id;
    accepted += 1;
  }

  if (plane.declarationErrors.length > 50) plane.declarationErrors = plane.declarationErrors.slice(-50);
  return { accepted, rejected: rawDeclarations.length - accepted, plane };
}

function interpretationFor(experiment, result) {
  if (result === "PASS") return experiment.pass_interpretation;
  if (result === "FAIL") return experiment.fail_interpretation;
  return "OBSERVES_ONLY";
}

function makeObservation(experiment, ev) {
  const body = {
    schema: FEEDBACK_SCHEMA,
    kind: FEEDBACK_KINDS.OBSERVATION,
    task_id: experiment.task_id,
    attempt: evidenceAttempt(ev) ?? experiment.attempt,
    experiment_id: experiment.experiment_id,
    hypothesis_id: experiment.hypothesis_id,
    evidence_id: factualEvidenceId(ev),
    command: evidenceCommand(ev),
    result: evidenceResult(ev),
    mutation_seq: evidenceMutationSeq(ev),
    interpretation: interpretationFor(experiment, evidenceResult(ev)),
  };
  return { ...body, observation_id: recordId("obs", body), observed_at: ev.timestamp || new Date().toISOString() };
}

function deriveHypothesisFeedback(hypothesis, experiments, observations) {
  const relevant = observations.filter((o) => o.hypothesis_id === hypothesis.hypothesis_id);
  const supported = relevant.filter((o) => o.interpretation === "SUPPORTS");
  const falsified = relevant.filter((o) => o.interpretation === "FALSIFIES");

  let status = FEEDBACK_STATUS.UNKNOWN;
  let causalPair = null;
  if (relevant.length > 0) status = FEEDBACK_STATUS.OBSERVED;
  if (supported.length > 0) status = FEEDBACK_STATUS.SUPPORTED;
  if (falsified.length > 0) status = FEEDBACK_STATUS.FALSIFIED;

  const abExperimentIds = new Set(
    experiments.filter((e) => e.hypothesis_id === hypothesis.hypothesis_id && e.design === "MUTATION_AB").map((e) => e.experiment_id),
  );
  const ab = relevant
    .filter((o) => abExperimentIds.has(o.experiment_id) && Number.isInteger(o.mutation_seq))
    .sort((a, b) => a.mutation_seq - b.mutation_seq);

  for (let i = 0; i < ab.length; i += 1) {
    for (let j = i + 1; j < ab.length; j += 1) {
      const before = ab[i];
      const after = ab[j];
      if (
        before.command === after.command &&
        before.result === "FAIL" &&
        after.result === "PASS" &&
        after.mutation_seq > before.mutation_seq &&
        (before.interpretation === "SUPPORTS" || after.interpretation === "SUPPORTS")
      ) {
        causalPair = { before: before.observation_id, after: after.observation_id };
        status = FEEDBACK_STATUS.CAUSALLY_VERIFIED;
        break;
      }
    }
    if (causalPair) break;
  }

  const body = {
    schema: FEEDBACK_SCHEMA,
    kind: FEEDBACK_KINDS.FEEDBACK,
    task_id: hypothesis.task_id,
    hypothesis_id: hypothesis.hypothesis_id,
    status,
    observation_ids: relevant.map((o) => o.observation_id).sort(),
    causal_pair: causalPair,
  };
  return { ...body, feedback_id: recordId("fb", body), derived_at: new Date().toISOString() };
}

export function reconcileFeedbackPlane(activeState) {
  const plane = ensureFeedbackState(activeState);
  const ledger = Array.isArray(activeState.evidenceLedger) ? activeState.evidenceLedger : [];
  const observations = [];

  for (const experiment of plane.experiments) {
    for (const ev of ledger) {
      if (!evidenceIsFactual(ev)) continue;
      if (evidenceCommand(ev) !== experiment.command) continue;
      const evAttempt = evidenceAttempt(ev);
      if (evAttempt !== null && evAttempt !== experiment.attempt) continue;
      observations.push(makeObservation(experiment, ev));
    }
  }

  const unique = new Map(observations.map((o) => [o.observation_id, o]));
  plane.observations = [...unique.values()].sort((a, b) => a.observation_id.localeCompare(b.observation_id));
  plane.feedback = plane.hypotheses.map((hyp) => deriveHypothesisFeedback(hyp, plane.experiments, plane.observations));
  plane.last_reconciled_at = new Date().toISOString();
  return plane;
}

export function feedbackSummary(activeState) {
  const plane = ensureFeedbackState(activeState);
  const counts = Object.fromEntries(Object.values(FEEDBACK_STATUS).map((s) => [s, 0]));
  for (const item of plane.feedback) counts[item.status] = (counts[item.status] || 0) + 1;
  return {
    schema: FEEDBACK_SCHEMA,
    hypotheses: plane.hypotheses.length,
    experiments: plane.experiments.length,
    observations: plane.observations.length,
    status_counts: counts,
    declaration_errors: plane.declarationErrors.length,
  };
}
