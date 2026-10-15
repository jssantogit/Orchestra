import test from "node:test";
import assert from "node:assert/strict";

import { decideCodexWork } from "../../runtimes/codex/.codex/astra-orchestra/direct-work-routing.mjs";
import { decideAntigravityWork } from "../../runtimes/antigravity/.agents/skills/orchestra/direct-work-routing.mjs";

const ON = { env: { ORCHESTRA_DIRECT_WORK_MODE: "on" } };

function shard(scope) {
  return {
    resolved: true,
    bounded: true,
    mutationScope: { allowedPaths: [scope], forbiddenPaths: [] },
  };
}

function validParallelFacts() {
  return {
    taskAction: "IMPLEMENT",
    bounded: true,
    independentWorkstreams: 2,
    unresolvedDiagnosis: false,
    openEndedDiagnosis: false,
    parallelImplementation: {
      requestedMode: "PARALLEL_2",
      shards: [shard("app/home/**"), shard("app/library/**")],
    },
  };
}

function decisions(facts) {
  return [
    decideCodexWork(facts, ON),
    decideAntigravityWork(facts, ON),
  ];
}

test("normal bounded implementation remains SERIAL with one primary worker", () => {
  for (const decision of decisions({ taskAction: "IMPLEMENT", bounded: true, independentWorkstreams: 1 })) {
    assert.equal(decision.directWork.implementationParallelism.mode, "SERIAL");
    assert.equal(decision.directWork.primaryWorkerCount, 1);
  }
});

test("two available providers alone never select parallel implementation", () => {
  for (const decision of decisions({
    taskAction: "IMPLEMENT",
    bounded: true,
    independentWorkstreams: 1,
    providerCapabilities: [
      { provider: "codex", available: true, capabilities: { implementation: true } },
      { provider: "antigravity", available: true, capabilities: { implementation: true } },
    ],
  })) {
    assert.equal(decision.directWork.implementationParallelism.mode, "SERIAL");
    assert.notEqual(decision.directWork.primaryWorkerCount, 2);
  }
});

test("explicit resolved bounded disjoint shards select PARALLEL_2 and return execution to CONTROL", () => {
  for (const decision of decisions(validParallelFacts())) {
    assert.equal(decision.directWork.implementationParallelism.mode, "PARALLEL_2");
    assert.equal(decision.directWork.implementationParallelism.reason, "EXPLICIT_PARALLEL_2");
    assert.equal(decision.directWork.primaryWorkerCount, 2);
    assert.equal(decision.directWork.controlReturned, true);
  }
});

test("parallel implementation fails closed to CONTROL when shards overlap or are not fully resolved", () => {
  const invalid = [
    {
      ...validParallelFacts(),
      parallelImplementation: {
        requestedMode: "PARALLEL_2",
        shards: [shard("app/**"), shard("app/home/**")],
      },
    },
    {
      ...validParallelFacts(),
      parallelImplementation: {
        requestedMode: "PARALLEL_2",
        shards: [{ ...shard("app/home/**"), resolved: false }, shard("app/library/**")],
      },
    },
    {
      ...validParallelFacts(),
      parallelImplementation: {
        requestedMode: "PARALLEL_2",
        shards: [shard("app/home/**")],
      },
    },
  ];

  for (const facts of invalid) {
    for (const decision of decisions(facts)) {
      assert.equal(decision.directWork.implementationParallelism.mode, "SERIAL");
      assert.equal(decision.directWork.implementationParallelism.reason, "PARALLEL_PREREQUISITES_UNMET");
      assert.notEqual(decision.directWork.primaryWorkerCount, 2);
      assert.equal(decision.directWork.controlReturned, true);
    }
  }
});

test("unresolved diagnosis never fans out implementation even with an explicit PARALLEL_2 request", () => {
  const facts = { ...validParallelFacts(), unresolvedDiagnosis: true };
  for (const decision of decisions(facts)) {
    assert.equal(decision.directWork.implementationParallelism.mode, "SERIAL");
    assert.equal(decision.directWork.implementationParallelism.reason, "PARALLEL_PREREQUISITES_UNMET");
    assert.notEqual(decision.directWork.primaryWorkerCount, 2);
    assert.equal(decision.directWork.controlReturned, true);
  }
});
