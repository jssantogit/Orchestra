import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const syntheticFixture = resolve(fileURLToPath(new URL("../../benchmarks/turn-economy/fixture", import.meta.url)));

function within(child, parent) {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + "/");
}

export function evaluateLiveEgress({
  projectRoot,
  live = false,
  env = process.env,
} = {}) {
  if (!live) {
    return { allowed: true, mode: "OFFLINE", reason: null };
  }

  if (projectRoot && within(projectRoot, syntheticFixture)) {
    return { allowed: true, mode: "SYNTHETIC_FIXTURE", reason: null };
  }

  if (env.ORCHESTRA_JEV_ALLOW_PROJECT_EGRESS === "1") {
    return { allowed: true, mode: "EXPLICIT_PROJECT_EGRESS", reason: null };
  }

  return {
    allowed: false,
    mode: "DENIED",
    reason: "JEV_PROJECT_EGRESS_REQUIRES_EXPLICIT_OPT_IN",
  };
}

export function assertLiveEgressAllowed(options = {}) {
  const result = evaluateLiveEgress(options);
  if (!result.allowed) throw new Error(result.reason);
  return result;
}
