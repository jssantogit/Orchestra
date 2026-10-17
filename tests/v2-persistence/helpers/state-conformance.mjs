import assert from "node:assert/strict";

export function defineStateConformanceSuite(test, { name, create }) {
  const project = () => ({
    schema: "orchestra.project.v2",
    projectId: "prj-conformance",
    lineageId: "lineage-conformance",
    workspace: { canonicalRoot: "C:/Projects/Conformance", vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 1 },
    trust: { mode: "trusted" },
  });

  const work = () => ({
    schema: "orchestra.work-unit.v2",
    workId: "work-conformance",
    projectId: "prj-conformance",
    taskId: "task-conformance",
    generation: 0,
    runtimeImage: "2.0.0",
    instructionEpoch: 1,
    state: "INTAKE",
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
  });

  const operation = () => ({
    schema: "orchestra.operation.v2",
    operationId: "op-conformance",
    projectId: "prj-conformance",
    workId: "work-conformance",
    generation: 1,
    kind: "DIRECT_MUTATION",
    actorRef: "actor:conformance",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-16T22:00:00.000Z",
    heartbeatAt: "2026-10-16T22:00:00.000Z",
    deadlineAt: "2026-10-16T22:10:00.000Z",
    runtimeOwnerRef: "process:conformance:token",
    workspaceRef: "workspace:canonical",
    resultRef: null,
  });

  test(`${name}: project/work/operation lifecycle obeys the shared v2 state contract`, async () => {
    const fixture = await create();
    const { state } = fixture;
    try {
      const registered = state.projects.register(project());
      assert.equal(registered.ok, true);
      assert.equal(state.projects.register(project()).replayed, true);

      const opened = state.work.startCurrent(work());
      assert.equal(opened.ok, true);
      assert.equal(state.work.startCurrent(work()).replayed, true);

      const transition = {
        projectId: "prj-conformance",
        workId: "work-conformance",
        expectedGeneration: 0,
        transitionId: "tr-conformance",
        patch: { state: "IMPLEMENTING", scopeRef: "scope:conformance" },
      };
      const transitioned = state.work.transition(transition);
      assert.equal(transitioned.ok, true);
      assert.equal(transitioned.work.generation, 1);
      assert.equal(state.work.transition(transition).replayed, true);
      assert.equal(state.work.transition({ ...transition, transitionId: "tr-stale" }).reason, "STALE_GENERATION");

      const began = state.operations.begin({ expectedGeneration: 1, operation: operation() });
      assert.equal(began.ok, true);
      assert.equal(state.operations.begin({ expectedGeneration: 1, operation: operation() }).replayed, true);

      const heartbeat = state.operations.heartbeat({
        operationId: "op-conformance",
        runtimeOwnerRef: "process:conformance:token",
        heartbeatAt: "2026-10-16T22:01:00.000Z",
      });
      assert.equal(heartbeat.ok, true);
      assert.equal(state.operations.listLive({ projectId: "prj-conformance", workId: "work-conformance", generation: 1 }).length, 1);

      const terminal = state.operations.terminalize({
        operationId: "op-conformance",
        workflowState: "COMPLETED",
        resultRef: "result:conformance",
      });
      assert.equal(terminal.ok, true);
      assert.equal(terminal.operation.liveness, "TERMINAL");
      assert.equal(state.operations.terminalize({
        operationId: "op-conformance",
        workflowState: "COMPLETED",
        resultRef: "result:conformance",
      }).replayed, true);
      assert.equal(state.operations.listLive({ projectId: "prj-conformance" }).length, 0);
    } finally {
      await fixture.cleanup?.();
    }
  });

  test(`${name}: cross-project work access fails closed`, async () => {
    const fixture = await create();
    const { state } = fixture;
    try {
      state.projects.register(project());
      state.projects.register({
        ...project(),
        projectId: "prj-other",
        lineageId: "lineage-other",
        workspace: { canonicalRoot: "C:/Projects/Other", vcs: "git" },
      });
      state.work.open(work());

      assert.equal(state.work.read("prj-other", "work-conformance"), null);
      const result = state.work.transition({
        projectId: "prj-other",
        workId: "work-conformance",
        expectedGeneration: 0,
        transitionId: "tr-cross",
        patch: { state: "BLOCKED" },
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "WORK_PROJECT_MISMATCH");
    } finally {
      await fixture.cleanup?.();
    }
  });
}
