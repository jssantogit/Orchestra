import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { Worker } from "node:worker_threads";

import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";
import { normalizeCodexActor } from "../../v2/providers/codex/actor.mjs";
import { normalizeCodexToolEvent } from "../../v2/providers/codex/tool-event.mjs";
import { runGlobalCli } from "../../v2/global/cli.mjs";
import { createGlobalProjectRegistry } from "../../v2/global/project-registry.mjs";

const actorA = `sha256:${"a".repeat(64)}`;
const actorB = `sha256:${"b".repeat(64)}`;
const correlationA = `sha256:${"c".repeat(64)}`;

function project(projectId = "prj-a", canonicalRoot = "C:/Projects/A") {
  return {
    schema: "orchestra.project.v2",
    projectId,
    lineageId: `lineage-${projectId}`,
    workspace: { canonicalRoot, vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 7 },
    trust: { mode: "trusted" },
  };
}

function work(workId, projectId) {
  return {
    schema: "orchestra.work-unit.v2",
    workId,
    projectId,
    taskId: `task-${workId}`,
    generation: 3,
    runtimeImage: "2.0.0",
    instructionEpoch: 7,
    state: "INTAKE",
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
  };
}

function operation(operationId, workId, projectId) {
  return {
    schema: "orchestra.operation.v2",
    operationId,
    projectId,
    workId,
    generation: 3,
    kind: "DIRECT_MUTATION",
    actorRef: "actor:provider-test",
    capabilities: ["WORKSPACE_EDIT"],
    workflowState: "RUNNING",
    liveness: "LIVE",
    startedAt: "2026-10-17T10:00:00.000Z",
    heartbeatAt: "2026-10-17T10:00:00.000Z",
    deadlineAt: "2026-10-17T10:10:00.000Z",
    runtimeOwnerRef: "provider-owner:test",
    workspaceRef: `workspace:${projectId}`,
    resultRef: null,
  };
}

async function withDb(fn) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-codex-adapter-"));
  const dbPath = join(root, "orchestra.db");
  const states = [];
  const openState = () => {
    const state = createSqliteState({ dbPath });
    states.push(state);
    return state;
  };
  try {
    await fn({ dbPath, openState });
  } finally {
    for (const state of states) state.close();
    await rm(root, { recursive: true, force: true });
  }
}

function seed(state) {
  for (const item of [project(), project("prj-b", "C:/Projects/B")]) {
    assert.equal(state.projects.register(item).ok, true);
  }
  assert.equal(state.work.startCurrent(work("work-a", "prj-a")).ok, true);
  assert.equal(state.work.startCurrent(work("work-b", "prj-b")).ok, true);
  assert.equal(state.operations.begin({
    expectedGeneration: 3,
    operation: operation("op-a", "work-a", "prj-a"),
  }).ok, true);
  assert.equal(state.operations.begin({
    expectedGeneration: 3,
    operation: operation("op-b", "work-b", "prj-b"),
  }).ok, true);
  assert.equal(state.operations.begin({
    expectedGeneration: 3,
    operation: { ...operation("op-a-alt", "work-a", "prj-a"), workspaceRef: "workspace:clone-a" },
  }).ok, true);
}

test("Session Observations are provider/project/actor scoped, refreshable and project fenced", async () => {
  await withDb(async ({ openState }) => {
    const state = openState();
    seed(state);

    const observation = {
      provider: "codex",
      projectId: "prj-a",
      actorIdHash: actorA,
      observedInstructionEpoch: 7,
      observedWorkId: "work-a",
      observedGeneration: 3,
      observedAt: "2026-10-17T10:00:00.000Z",
    };
    const first = state.sessionObservations.put(observation);
    const replay = state.sessionObservations.put(observation);
    assert.equal(first.ok, true);
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.deepEqual(state.sessionObservations.get({
      provider: "codex", projectId: "prj-a", actorIdHash: actorA,
    }), observation);

    const otherActor = state.sessionObservations.put({ ...observation, actorIdHash: actorB });
    const otherProject = state.sessionObservations.put({ ...observation, projectId: "prj-b", observedWorkId: null, observedGeneration: null });
    const otherProvider = state.sessionObservations.put({ ...observation, provider: "antigravity" });
    assert.equal(otherActor.ok, true);
    assert.equal(otherProject.ok, true);
    assert.equal(otherProvider.ok, true);
    assert.equal(state.sessionObservations.get({ provider: "codex", projectId: "prj-a", actorIdHash: actorB }).observedWorkId, "work-a");
    assert.equal(state.sessionObservations.get({ provider: "codex", projectId: "prj-b", actorIdHash: actorA }).observedWorkId, null);
    assert.equal(state.sessionObservations.get({ provider: "antigravity", projectId: "prj-a", actorIdHash: actorA }).observedWorkId, "work-a");

    const crossProject = state.sessionObservations.put({
      ...observation,
      actorIdHash: `sha256:${"d".repeat(64)}`,
      observedWorkId: "work-b",
    });
    assert.equal(crossProject.ok, false);
    assert.equal(crossProject.reason, "SESSION_OBSERVATION_WORK_PROJECT_MISMATCH");

    const refreshed = state.sessionObservations.put({
      ...observation,
      observedInstructionEpoch: 8,
      observedAt: "2026-10-17T10:01:00.000Z",
    });
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.replayed, false);
    assert.equal(state.sessionObservations.get({ provider: "codex", projectId: "prj-a", actorIdHash: actorA }).observedInstructionEpoch, 8);
    const stale = state.sessionObservations.put({
      ...observation,
      observedInstructionEpoch: 9,
      observedAt: "2026-10-17T10:00:30.000Z",
    });
    const sameTimestampConflict = state.sessionObservations.put({
      ...observation,
      observedInstructionEpoch: 9,
      observedAt: "2026-10-17T10:01:00.000Z",
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, "SESSION_OBSERVATION_CONFLICT");
    assert.equal(sameTimestampConflict.ok, false);
    assert.equal(sameTimestampConflict.reason, "SESSION_OBSERVATION_CONFLICT");
    state.close();

    const reopened = openState();
    assert.equal(reopened.sessionObservations.get({ provider: "codex", projectId: "prj-a", actorIdHash: actorA }).observedInstructionEpoch, 8);
    assert.equal(reopened.sessionObservations.get({ provider: "antigravity", projectId: "prj-a", actorIdHash: actorA }).observedInstructionEpoch, 7);
    reopened.close();
  });
});

test("tool correlations bind one exact operation tuple and survive restart", async () => {
  await withDb(async ({ dbPath, openState }) => {
    const state = openState();
    seed(state);
    const correlation = {
      provider: "codex",
      projectId: "prj-a",
      correlationHash: correlationA,
      operationId: "op-a",
      workId: "work-a",
      generation: 3,
      actorIdHash: actorA,
    };

    const first = state.operationCorrelations.put(correlation);
    const replay = state.operationCorrelations.put(correlation);
    assert.equal(first.ok, true);
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.deepEqual(state.operationCorrelations.get({
      provider: "codex", projectId: "prj-a", correlationHash: correlationA,
    }), correlation);

    const conflict = state.operationCorrelations.put({ ...correlation, operationId: "op-a-alt" });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, "OPERATION_CORRELATION_CONFLICT");

    const differentWork = state.operationCorrelations.put({ ...correlation, workId: "work-b", projectId: "prj-b" });
    const differentGeneration = state.operationCorrelations.put({ ...correlation, generation: 4 });
    const differentActor = state.operationCorrelations.put({ ...correlation, actorIdHash: actorB });
    const crossProjectOperation = state.operationCorrelations.put({ ...correlation, operationId: "op-b" });
    assert.equal(differentWork.ok, false);
    assert.equal(differentWork.reason, "OPERATION_CORRELATION_OPERATION_MISMATCH");
    assert.equal(differentGeneration.ok, false);
    assert.equal(differentGeneration.reason, "OPERATION_CORRELATION_OPERATION_MISMATCH");
    assert.equal(differentActor.ok, false);
    assert.equal(differentActor.reason, "OPERATION_CORRELATION_CONFLICT");
    assert.equal(crossProjectOperation.ok, false);
    assert.equal(crossProjectOperation.reason, "OPERATION_CORRELATION_OPERATION_MISMATCH");

    const otherProject = state.operationCorrelations.put({
      ...correlation,
      projectId: "prj-b",
      operationId: "op-b",
      workId: "work-b",
    });
    const otherProvider = state.operationCorrelations.put({ ...correlation, provider: "antigravity" });
    assert.equal(otherProject.ok, true);
    assert.equal(otherProvider.ok, true);
    assert.equal(state.operationCorrelations.get({ provider: "codex", projectId: "prj-b", correlationHash: correlationA }).operationId, "op-b");
    assert.equal(state.operationCorrelations.get({ provider: "antigravity", projectId: "prj-a", correlationHash: correlationA }).operationId, "op-a");

    state.close();
    const reopened = openState();
    assert.deepEqual(reopened.operationCorrelations.get({
      provider: "codex", projectId: "prj-a", correlationHash: correlationA,
    }), correlation);
    reopened.close();
  });
});

test("concurrent identical provider correlations converge across SQLite connections", async () => {
  await withDb(async ({ dbPath, openState }) => {
    const state = openState();
    seed(state);
    state.close();

    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const workerSource = `
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        const { createSqliteState } = await import(workerData.moduleUrl);
        const state = createSqliteState({ dbPath: workerData.dbPath });
        parentPort.postMessage({ ready: true });
        const gate = new Int32Array(workerData.gate);
        while (Atomics.load(gate, 0) === 0) Atomics.wait(gate, 0, 0, 10000);
        const failures = [];
        for (let index = 0; index < workerData.count; index += 1) {
          const correlationHash = "sha256:" + String(index).padStart(64, "0");
          try {
            const result = state.operationCorrelations.put({ ...workerData.correlation, correlationHash });
            if (!result.ok) failures.push(result.reason);
          } catch (error) {
            failures.push(error.code ?? error.message);
          }
        }
        state.close();
        parentPort.postMessage({ done: true, failures });
      })().catch((error) => parentPort.postMessage({ fatal: error.message }));
    `;
    const workerCount = 8;
    const workers = [];
    try {
      const jobs = Array.from({ length: workerCount }, () => {
        const worker = new Worker(workerSource, {
          eval: true,
          workerData: {
            dbPath,
            moduleUrl: new URL("../../v2/persistence/sqlite/sqlite-state.mjs", import.meta.url).href,
            gate,
            count: 64,
            correlation: {
              provider: "codex",
              projectId: "prj-a",
              operationId: "op-a",
              workId: "work-a",
              generation: 3,
              actorIdHash: actorA,
            },
          },
        });
        workers.push(worker);
        let resolveReady;
        let rejectReady;
        let resolveDone;
        let rejectDone;
        const ready = new Promise((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        const done = new Promise((resolve, reject) => {
          resolveDone = resolve;
          rejectDone = reject;
        });
        let readySettled = false;
        let doneSettled = false;
        const rejectBoth = (error) => {
          if (!readySettled) {
            readySettled = true;
            rejectReady(error);
          }
          if (!doneSettled) {
            doneSettled = true;
            rejectDone(error);
          }
        };
        worker.on("message", (message) => {
          if (message.ready && !readySettled) {
            readySettled = true;
            resolveReady();
          }
          if (message.fatal) rejectBoth(new Error(message.fatal));
          if (message.done && !doneSettled) {
            doneSettled = true;
            resolveDone(message.failures);
          }
        });
        worker.on("error", rejectBoth);
        worker.on("exit", (code) => {
          if (code !== 0) rejectBoth(new Error(`worker exited with code ${code}`));
          else if (!doneSettled) rejectBoth(new Error("worker exited before reporting completion"));
        });
        return { ready, done };
      });

      let timeout;
      try {
        await Promise.race([
          Promise.all(jobs.map((job) => job.ready)),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("concurrent correlation workers timed out")), 30_000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0, workerCount);

      let doneTimeout;
      let failures;
      try {
        failures = await Promise.race([
          Promise.all(jobs.map((job) => job.done)),
          new Promise((_, reject) => {
            doneTimeout = setTimeout(() => reject(new Error("concurrent correlation workers timed out")), 30_000);
          }),
        ]);
      } finally {
        clearTimeout(doneTimeout);
      }
      assert.deepEqual(failures.flat(), []);
    } finally {
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0, workerCount);
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  });
});

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

test("Codex actor provenance hashes factual root and child identities and rejects missing payload identity", () => {
  assert.deepEqual(normalizeCodexActor({ session_id: "root-1" }), {
    provider: "codex",
    actorIdHash: hash("root-1"),
    actorKind: "ROOT",
    isRoot: true,
  });
  assert.equal(normalizeCodexActor({ session_id: " root-1 " }).actorIdHash, hash(" root-1 "));
  assert.deepEqual(normalizeCodexActor({ session_id: "root-1", agent_id: "agent-2" }), {
    provider: "codex",
    actorIdHash: hash("agent-2"),
    actorKind: "CHILD",
    parentActorIdHash: hash("root-1"),
    isRoot: false,
  });
  assert.throws(() => normalizeCodexActor({}, { CODEX_SESSION_ID: "environment-only" }), {
    code: "CODEX_PROVIDER_IDENTITY_INVALID",
  });
  for (const agent_id of ["", "  ", 7, null]) {
    assert.throws(() => normalizeCodexActor({ session_id: "root-1", agent_id }), {
      code: "CODEX_PROVIDER_IDENTITY_INVALID",
    });
  }
  assert.deepEqual(normalizeCodexToolEvent({
    hook_event_name: "PreToolUse",
    session_id: "root-1",
    tool_name: "read_file",
  }), {
    eventType: "TOOL_REQUEST",
    operation: "READ",
    sideEffectClass: "READ_ONLY",
    factualIds: { actorIdHash: hash("root-1") },
  });
  const longToolCallId = `call-${"x".repeat(500)}`;
  assert.equal(normalizeCodexToolEvent({
    hook_event_name: "PreToolUse",
    session_id: "root-1",
    tool_name: "write_file",
    tool_call_id: longToolCallId,
  }).factualIds.toolCallId, longToolCallId);
});

async function makeWorkspace(root) {
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  execFileSync("git", ["init", "--quiet", workspace]);
  return workspace;
}

async function invokeHook({ home, cwd, payload, rawInput, env = {} }) {
  let stdout = "";
  let stderr = "";
  const code = await runGlobalCli({
    argv: ["provider", "codex", "hook"],
    cwd,
    env: { ...env, ORCHESTRA_HOME: home },
    stdin: Readable.from([rawInput ?? JSON.stringify(payload)]),
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  });
  return { code, payload: JSON.parse(stdout || stderr) };
}

async function prepareRegisteredWorkspace({ root, home, active = true }) {
  const cwd = await makeWorkspace(root);
  const registry = createGlobalProjectRegistry({ home });
  try {
    const registered = await registry.registerWorkspace({
      root: cwd,
      runtimeImage: "2.0.0",
      instructionEpoch: 7,
      trustMode: "trusted",
    });
    assert.equal(registered.ok, true);
    if (active) assert.equal(registry.state.work.startCurrent(work("work-hook", registered.project.projectId)).ok, true);
    return { cwd, project: registered.project };
  } finally {
    registry.close();
  }
}

test("global SessionStart attaches active Work, persists observation, and allows another fresh session", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-hook-active-"));
  try {
    const home = join(root, "home");
    const { cwd, project: registered } = await prepareRegisteredWorkspace({ root, home });
    const first = await invokeHook({
      home, cwd,
      payload: { hook_event_name: "SessionStart", session_id: "fresh-1" },
    });
    const second = await invokeHook({
      home, cwd,
      payload: { hook_event_name: "SessionStart", session_id: "fresh-2" },
    });
    assert.equal(first.code, 0);
    assert.equal(first.payload.ok, true);
    assert.equal(first.payload.work.workId, "work-hook");
    assert.equal(second.code, 0);
    assert.equal(second.payload.work.workId, "work-hook");
    assert.equal(first.payload.hookSpecificOutput.hookEventName, "SessionStart");
    const context = JSON.parse(first.payload.hookSpecificOutput.additionalContext);
    assert.equal(context.projectId, registered.projectId);
    assert.equal(context.work.workId, "work-hook");
    assert.equal(context.generation, 3);
    assert.equal(context.instructionEpoch, 7);

    const state = createSqliteState({ dbPath: join(home, "state", "orchestra.db") });
    try {
      for (const sessionId of ["fresh-1", "fresh-2"]) {
        const observation = state.sessionObservations.get({
          provider: "codex",
          projectId: registered.projectId,
          actorIdHash: hash(sessionId),
        });
        assert.equal(observation.observedInstructionEpoch, 7);
        assert.equal(observation.observedWorkId, "work-hook");
        assert.equal(observation.observedGeneration, 3);
        assert.equal(typeof observation.observedAt, "string");
      }
    } finally {
      state.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionStart returns successful intake without active work and does not self-register", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-hook-intake-"));
  const home = join(root, "home");
  try {
    const { cwd } = await prepareRegisteredWorkspace({ root, home, active: false });
    const intake = await invokeHook({
      home, cwd,
      payload: { hook_event_name: "SessionStart", session_id: "intake-1" },
    });
    assert.equal(intake.code, 0);
    assert.equal(intake.payload.reason, "ORCHESTRA_V2_INTAKE");
    assert.equal(intake.payload.work, null);
    assert.equal(intake.payload.generation, null);
    assert.equal(intake.payload.hookSpecificOutput.hookEventName, "SessionStart");
    const context = JSON.parse(intake.payload.hookSpecificOutput.additionalContext);
    assert.equal(context.activeWork, null);
    assert.equal(context.generation, null);
    assert.equal(context.mutationAuthority, "UNAVAILABLE_UNTIL_WORK_STARTS");

    const intakeRegistry = createGlobalProjectRegistry({ home });
    try {
      const project = await intakeRegistry.resolveWorkspace(cwd);
      const observation = intakeRegistry.state.sessionObservations.get({
        provider: "codex",
        projectId: project.projectId,
        actorIdHash: hash("intake-1"),
      });
      assert.equal(observation.observedWorkId, null);
      assert.equal(observation.observedGeneration, null);
      assert.equal(observation.observedInstructionEpoch, 7);
    } finally {
      intakeRegistry.close();
    }

    const unregisteredRoot = join(root, "other");
    await mkdir(unregisteredRoot);
    const unregistered = await makeWorkspace(unregisteredRoot);
    const denied = await invokeHook({
      home, cwd: unregistered,
      payload: { hook_event_name: "SessionStart", session_id: "unregistered-1" },
    });
    assert.equal(denied.code, 1);
    assert.equal(denied.payload.reason, "PROJECT_NOT_REGISTERED");
    const registry = createGlobalProjectRegistry({ home });
    try {
      assert.equal(await registry.resolveWorkspace(unregistered), null);
    } finally {
      registry.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider CLI emits structured invalid-payload and identity errors without raw identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-hook-invalid-"));
  const home = join(root, "empty-home");
  try {
    const malformed = await invokeHook({ home, cwd: root, rawInput: "{" });
    assert.equal(malformed.code, 1);
    assert.equal(malformed.payload.reason, "CODEX_HOOK_PAYLOAD_INVALID");

    const registeredHome = join(root, "registered-home");
    const { cwd } = await prepareRegisteredWorkspace({ root, home: registeredHome });
    const invalidIdentity = await invokeHook({
      home: registeredHome,
      cwd,
      env: { CODEX_SESSION_ID: "environment-session" },
      payload: { hook_event_name: "SessionStart" },
    });
    assert.equal(invalidIdentity.code, 1);
    assert.equal(invalidIdentity.payload.reason, "CODEX_PROVIDER_IDENTITY_INVALID");
    assert.equal(JSON.stringify(invalidIdentity.payload).includes("environment-session"), false);

    const noProject = await invokeHook({
      home,
      cwd: root,
      payload: { hook_event_name: "SessionStart", session_id: "secret-session" },
    });
    assert.equal(noProject.code, 1);
    assert.equal(noProject.payload.reason, "PROJECT_NOT_REGISTERED");
    assert.equal(JSON.stringify(noProject.payload).includes("secret-session"), false);
    await assert.rejects(access(home), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
