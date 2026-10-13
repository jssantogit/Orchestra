import test from "node:test";
import assert from "node:assert/strict";

import { discoverDelegationProviders } from "../../runtime/delegation/discovery.mjs";

function executor(provider, response) {
  return {
    provider,
    async discover() {
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

test("provider discovery is READY only when both cross-provider executors are factually available", async () => {
  const result = await discoverDelegationProviders({
    executors: [
      executor("antigravity", { available: true, provider: "antigravity", version: "agy 1.2.3" }),
      executor("codex", { available: true, provider: "codex", version: "codex 0.130.0" }),
    ],
  });

  assert.equal(result.status, "READY");
  assert.equal(result.availableCount, 2);
  assert.deepEqual(result.providers.map((entry) => entry.provider), ["antigravity", "codex"]);
});

test("provider discovery is DEGRADED when exactly one executor is available", async () => {
  const result = await discoverDelegationProviders({
    executors: [
      executor("antigravity", { available: true, provider: "antigravity", version: "agy 1.2.3" }),
      executor("codex", { available: false, provider: "codex", reason: "PROVIDER_UNAVAILABLE" }),
    ],
  });

  assert.equal(result.status, "DEGRADED");
  assert.equal(result.availableCount, 1);
  assert.equal(result.providers[1].reason, "PROVIDER_UNAVAILABLE");
});

test("provider discovery is UNAVAILABLE when no executor is available and converts thrown probes to bounded facts", async () => {
  const result = await discoverDelegationProviders({
    executors: [
      executor("antigravity", new Error("secret agy detail")),
      executor("codex", { available: false, provider: "codex", reason: "PROVIDER_UNAVAILABLE" }),
    ],
  });

  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.availableCount, 0);
  assert.deepEqual(result.providers[0], {
    available: false,
    provider: "antigravity",
    reason: "PROVIDER_UNAVAILABLE",
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("provider discovery rejects malformed executor composition instead of inferring readiness", async () => {
  await assert.rejects(
    discoverDelegationProviders({ executors: [{ provider: "codex" }] }),
    /DELEGATION_DISCOVERY_EXECUTOR_INVALID/,
  );
});
