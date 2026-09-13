import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  deliverPendingAdvisories,
  consumeDeliveredAdvisories,
} from "../skills/agy-orchestra/routing-policy.mjs";

function main() {
  const statePath = resolve(process.cwd(), ".agents/state/active-state.json");
  const injectSteps = [];

  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      let stateModified = false;

      // 1. Consume previously delivered advisories so they are never re-injected
      const consumedCount = consumeDeliveredAdvisories(state);
      if (consumedCount > 0) {
        stateModified = true;
      }

      // 2. Deliver any pending advisories
      const delivered = deliverPendingAdvisories(state);
      if (delivered.length > 0) {
        stateModified = true;
        for (const adv of delivered) {
          injectSteps.push({ ephemeralMessage: adv.message });
        }
      }

      // 3. Existing circuit breaker warnings
      if (state.loopSuspected || state.circuitBreakerType === "LOOP_SUSPECTED") {
        injectSteps.push({
          ephemeralMessage: "LOOP CIRCUIT BREAKER: Repeated file reads detected without state progress. Do not re-read files; synthesize findings or transition to HUMAN_GATE."
        });
      }

      if (state.stalled || state.circuitBreakerType === "STALLED") {
        injectSteps.push({
          ephemeralMessage: "STALLED CIRCUIT BREAKER: Repeated identical tool executions or retry reasons detected without forward progress. Halt and generate UNRESOLVED_DECISION_PACKET for HUMAN_GATE."
        });
      }

      if (state.coordinationOverheadDetected || state.circuitBreakerType === "COORDINATION_OVERHEAD") {
        injectSteps.push({
          ephemeralMessage: "COORDINATION OVERHEAD DETECTED: Multiple retries or excessive orchestration turns recorded. Ensure delta handoff is compact, root cause is isolated, or halt to HUMAN_GATE."
        });
      }

      if (state.contextBloatDetected || state.circuitBreakerType === "CONTEXT_BLOAT") {
        injectSteps.push({
          ephemeralMessage: "CONTEXT BLOAT WARNING: Output or handoff size is high. Compress logs, omit repetitive code, and transfer only essential facts."
        });
      }

      if (state.humanGateRequired || state.state === "HUMAN_GATE") {
        injectSteps.push({
          ephemeralMessage: "HUMAN GATE ACTIVE: Automation cannot safely resolve current state. Stop tool execution and present UNRESOLVED_DECISION_PACKET to user."
        });
      }

      if (state.directActionOverheadDetected || state.circuitBreakerType === "DIRECT_ACTION_OVERHEAD") {
        injectSteps.push({
          ephemeralMessage: "DIRECT_ACTION_OVERHEAD: Target for direct action is 1-3 tool calls. Consolidate operations via git-operation.mjs or execute command directly."
        });
      }

      if (state.directActionOverthinkingDetected || state.circuitBreakerType === "DIRECT_ACTION_OVERTHINKING") {
        injectSteps.push({
          ephemeralMessage: "DIRECT_ACTION_OVERTHINKING: Multiple model turns elapsed on direct operational action. Conclude execution without additional deliberation."
        });
      }

      if (state.shellOveruseDetected && !state.shellOveruseAdvised) {
        injectSteps.push({
          ephemeralMessage: "NATIVE_TOOLS_FIRST: Use view_file / grep_search / find_by_name / edit tools for repository inspection. Reserve run_command for execution or unsupported native queries."
        });
        state.shellOveruseAdvised = true;
        stateModified = true;
      } else if (!state.shellOveruseDetected && state.shellOveruseAdvised) {
        delete state.shellOveruseAdvised;
        stateModified = true;
      }

      if (stateModified) {
        try {
          writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
        } catch {}
      }
    } catch {}
  }

  console.log(JSON.stringify({ injectSteps }));
}

main();
