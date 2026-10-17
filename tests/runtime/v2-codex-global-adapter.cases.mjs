import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { Worker } from "node:worker_threads";

import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";
import { normalizeCodexActor } from "../../v2/providers/codex/actor.mjs";
import { normalizeCodexToolEvent } from "../../v2/providers/codex/tool-event.mjs";
import { createRuntimeOwnerStore } from "../../v2/liveness/runtime-owner-store.mjs";
import { runGlobalCli } from "../../v2/global/cli.mjs";
import { createGlobalProjectRegistry } from "../../v2/global/project-registry.mjs";
import { createCodexHookHandler } from "../../v2/providers/codex/hook-handler.mjs";

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

test("registering a Codex v2 project does not install a local governance runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-codex-register-no-brain-"));
  try {
    const cwd = await makeWorkspace(root);
    const home = join(root, "home");
    let stdout = "";
    const code = await runGlobalCli({
      argv: ["register", cwd, "--runtime-image", "2.0.0", "--instruction-epoch", "7", "--trust", "trusted"],
      cwd,
      env: { ORCHESTRA_HOME: home },
      stdin: Readable.from([]),
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: () => {} },
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).ok, true);
    await assert.rejects(access(join(cwd, ".codex")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit Codex shim installation requires registration and targets the stable global launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-codex-shim-install-"));
  try {
    const home = join(root, "home");
    const { cwd } = await prepareRegisteredWorkspace({ root, home, active: false });
    let stdout = "";
    const code = await runGlobalCli({
      argv: ["provider", "codex", "shim", "install", "--home", home],
      cwd,
      env: {},
      stdin: Readable.from([]),
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: () => {} },
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).ok, true);
    const shim = await readFile(join(cwd, ".codex/orchestra-v2-hook.mjs"), "utf8");
    const expectedLauncher = fileURLToPath(new URL("../../v2/global/orchestra.mjs", import.meta.url));
    assert.equal(shim.includes(JSON.stringify(expectedLauncher)), true);
    assert.equal(shim.includes(JSON.stringify(home)), true);
    const hooks = JSON.parse(await readFile(join(cwd, ".codex/hooks.json"), "utf8"));
    assert.equal(Array.isArray(hooks.hooks.SessionStart), true);
    assert.equal(Array.isArray(hooks.hooks.PreToolUse), true);
    assert.equal(Array.isArray(hooks.hooks.PostToolUse), true);
    const shimEnv = { ...process.env };
    delete shimEnv.ORCHESTRA_HOME;
    const output = execFileSync(process.execPath, [join(cwd, ".codex/orchestra-v2-hook.mjs")], {
      cwd,
      env: shimEnv,
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "shim-home-test" }),
      encoding: "utf8",
    });
    const forwarded = JSON.parse(output);
    assert.equal(forwarded.reason, "ORCHESTRA_V2_INTAKE");
    assert.equal(forwarded.hookSpecificOutput.hookEventName, "SessionStart");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed global shim preserves active Codex hook responses across attach and tool lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-codex-shim-active-"));
  try {
    const home = join(root, "home");
    const { cwd } = await prepareRegisteredWorkspace({ root, home, active: true });
    let installOutput = "";
    const installCode = await runGlobalCli({
      argv: ["provider", "codex", "shim", "install", "--home", home],
      cwd,
      env: {},
      stdin: Readable.from([]),
      stdout: { write: (chunk) => { installOutput += chunk; } },
      stderr: { write: () => {} },
    });
    assert.equal(installCode, 0);
    assert.equal(JSON.parse(installOutput).ok, true);

    const shimPath = join(cwd, ".codex/orchestra-v2-hook.mjs");
    const shimEnv = { ...process.env };
    delete shimEnv.ORCHESTRA_HOME;
    const invoke = (payload) => JSON.parse(execFileSync(process.execPath, [shimPath], {
      cwd,
      env: shimEnv,
      input: JSON.stringify({ ...payload, cwd }),
      encoding: "utf8",
    }));

    const attached = invoke({ hook_event_name: "SessionStart", session_id: "shim-active-session" });
    assert.equal(attached.ok, true);
    assert.equal(attached.hookSpecificOutput.hookEventName, "SessionStart");
    assert.equal(JSON.parse(attached.hookSpecificOutput.additionalContext).work.workId, "work-hook");

    const read = invoke({ hook_event_name: "PreToolUse", session_id: "shim-active-session", tool_name: "read_file" });
    assert.equal(read.ok, true);
    assert.equal(read.reason, null);
    assert.equal(read.hookSpecificOutput.permissionDecision, "allow");

    const mutation = invoke({
      hook_event_name: "PreToolUse",
      session_id: "shim-active-session",
      tool_name: "write_file",
      tool_call_id: "shim-active-call",
    });
    assert.equal(mutation.ok, true);
    assert.equal(mutation.reason, null);
    assert.equal(mutation.hookSpecificOutput.permissionDecision, "allow");

    const terminal = invoke({
      hook_event_name: "PostToolUse",
      session_id: "shim-active-session",
      tool_name: "write_file",
      tool_call_id: "shim-active-call",
      is_error: false,
    });
    assert.equal(terminal.ok, true);
    assert.equal(terminal.reason, null);
    assert.equal(terminal.operation.workflowState, "SUCCEEDED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

test("PreToolUse requires a current Session Observation and delegates freshness and identity fences", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-hook-pretool-fences-"));
  const home = join(root, "home");
  try {
    const { cwd, project: registered } = await prepareRegisteredWorkspace({ root, home });
    const invoke = (sessionId) => invokeHook({
      home,
      cwd,
      payload: {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_name: "write_file",
        tool_call_id: `call-${sessionId}`,
        cwd,
      },
    });

    const missing = await invoke("missing-observation");
    assert.equal(missing.code, 1);
    assert.equal(missing.payload.reason, "CODEX_SESSION_OBSERVATION_MISSING");
    assert.equal(missing.payload.hookSpecificOutput.permissionDecision, "deny");

    const state = createSqliteState({ dbPath: join(home, "state", "orchestra.db") });
    try {
      const putObservation = (sessionId, overrides = {}) => state.sessionObservations.put({
        provider: "codex",
        projectId: registered.projectId,
        actorIdHash: hash(sessionId),
        observedInstructionEpoch: 7,
        observedWorkId: "work-hook",
        observedGeneration: 3,
        observedAt: "2026-10-17T10:00:00.000Z",
        ...overrides,
      });
      assert.equal(putObservation("epoch-drift", { observedInstructionEpoch: 6 }).ok, true);
      assert.equal(state.work.open(work("old-work", registered.projectId)).ok, true);
      assert.equal(putObservation("stale-work", { observedWorkId: "old-work" }).ok, true);
      assert.equal(putObservation("stale-generation", { observedGeneration: 2 }).ok, true);
    } finally {
      state.close();
    }

    const epochDrift = await invoke("epoch-drift");
    assert.equal(epochDrift.code, 1);
    assert.equal(epochDrift.payload.reason, "SESSION_RUNTIME_STALE");
    assert.equal(epochDrift.payload.hookSpecificOutput.permissionDecision, "deny");
    const staleWork = await invoke("stale-work");
    assert.equal(staleWork.code, 1);
    assert.equal(staleWork.payload.reason, "STALE_ACTIVE_WORK");
    const staleGeneration = await invoke("stale-generation");
    assert.equal(staleGeneration.code, 1);
    assert.equal(staleGeneration.payload.reason, "STALE_GENERATION");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PreToolUse allows proven read-only tools without creating a mutation Operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-hook-pretool-read-"));
  const home = join(root, "home");
  try {
    const { cwd, project: registered } = await prepareRegisteredWorkspace({ root, home });
    const started = await invokeHook({ home, cwd, payload: { hook_event_name: "SessionStart", session_id: "reader" } });
    assert.equal(started.code, 0);
    const response = await invokeHook({
      home,
      cwd,
      payload: {
        hook_event_name: "PreToolUse",
        session_id: "reader",
        tool_name: "read_file",
        tool_call_id: "read-call",
        cwd,
      },
    });
    assert.equal(response.code, 0);
    assert.equal(response.payload.hookSpecificOutput.permissionDecision, "allow");
    const state = createSqliteState({ dbPath: join(home, "state", "orchestra.db") });
    try {
      assert.deepEqual(state.operations.listLive({ projectId: registered.projectId }), []);
      assert.equal(state.operationCorrelations.get({
        provider: "codex", projectId: registered.projectId, correlationHash: hash("read-call"),
      }), null);
    } finally {
      state.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PreToolUse tracks conservative mutations by exact hashed tool correlation and blocks competing writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-hook-pretool-mutation-"));
  const home = join(root, "home");
  try {
    const { cwd, project: registered } = await prepareRegisteredWorkspace({ root, home });
    const started = await invokeHook({ home, cwd, payload: { hook_event_name: "SessionStart", session_id: "mutator" } });
    assert.equal(started.code, 0);

    const missingId = await invokeHook({
      home,
      cwd,
      payload: { hook_event_name: "PreToolUse", session_id: "mutator", tool_name: "bash", cwd },
    });
    assert.equal(missingId.code, 1);
    assert.equal(missingId.payload.reason, "CODEX_TOOL_CORRELATION_REQUIRED");

    const mutation = {
      hook_event_name: "PreToolUse",
      session_id: "mutator",
      tool_name: "bash",
      tool_call_id: "exact-tool-call-1",
      cwd,
    };
    const first = await invokeHook({ home, cwd, payload: mutation });
    assert.equal(first.code, 0);
    assert.equal(first.payload.hookSpecificOutput.permissionDecision, "allow");
    const replay = await invokeHook({ home, cwd, payload: mutation });
    assert.equal(replay.code, 0);
    assert.equal(replay.payload.operation.operationId, first.payload.operation.operationId);
    assert.equal(replay.payload.replayed, true);

    const state = createSqliteState({ dbPath: join(home, "state", "orchestra.db") });
    try {
      const operations = state.operations.listLive({ projectId: registered.projectId });
      assert.equal(operations.length, 1);
      assert.equal(operations[0].workId, "work-hook");
      assert.equal(operations[0].generation, 3);
      assert.match(operations[0].runtimeOwnerRef, /^provider-owner:/);
      assert.equal(String(operations[0].runtimeOwnerRef).includes(String(process.pid)), false);
      const correlation = state.operationCorrelations.get({
        provider: "codex",
        projectId: registered.projectId,
        correlationHash: hash("exact-tool-call-1"),
      });
      assert.equal(correlation.operationId, operations[0].operationId);
      assert.equal(correlation.actorIdHash, hash("mutator"));
      assert.equal(JSON.stringify(correlation).includes("exact-tool-call-1"), false);

      const incompatible = await invokeHook({
        home,
        cwd,
        payload: { ...mutation, tool_call_id: "exact-tool-call-2" },
      });
      assert.equal(incompatible.code, 1);
      assert.equal(incompatible.payload.hookSpecificOutput.permissionDecision, "deny");
      assert.equal(incompatible.payload.reason, "INCOMPATIBLE_LIVE_OPERATION");
      assert.equal(state.operations.listLive({ projectId: registered.projectId }).length, 1);
      const ownerStore = createRuntimeOwnerStore({ rootDir: join(home, "runtime-owners") });
      const owner = await ownerStore.read(operations[0].runtimeOwnerRef);
      assert.equal(owner.kind, "PROVIDER_EVENT");
      assert.equal(owner.correlationRef, hash("exact-tool-call-1"));
    } finally {
      state.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown tools take the mutation path instead of being silently classified as read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-hook-pretool-unknown-"));
  const home = join(root, "home");
  try {
    const { cwd, project: registered } = await prepareRegisteredWorkspace({ root, home });
    await invokeHook({ home, cwd, payload: { hook_event_name: "SessionStart", session_id: "unknown-tool" } });
    const response = await invokeHook({
      home,
      cwd,
      payload: {
        hook_event_name: "PreToolUse",
        session_id: "unknown-tool",
        tool_name: "custom_side_effect_tool",
        tool_call_id: "custom-call",
        cwd,
      },
    });
    assert.equal(response.code, 0);
    assert.equal(response.payload.hookSpecificOutput.permissionDecision, "allow");
    const state = createSqliteState({ dbPath: join(home, "state", "orchestra.db") });
    try {
      const operations = state.operations.listLive({ projectId: registered.projectId });
      assert.equal(operations.length, 1);
      assert.equal(state.operationCorrelations.get({
        provider: "codex", projectId: registered.projectId, correlationHash: hash("custom-call"),
      }).operationId, operations[0].operationId);
    } finally {
      state.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replaying a correlated mutation after its Operation is terminal fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-hook-pretool-terminal-replay-"));
  const home = join(root, "home");
  let registry;
  try {
    const { cwd, project: registered } = await prepareRegisteredWorkspace({ root, home });
    await invokeHook({ home, cwd, payload: { hook_event_name: "SessionStart", session_id: "terminal-replay" } });
    const payload = {
      hook_event_name: "PreToolUse",
      session_id: "terminal-replay",
      tool_name: "write_file",
      tool_call_id: "terminal-replay-call",
      cwd,
    };
    const first = await invokeHook({ home, cwd, payload });
    assert.equal(first.code, 0);
    registry = createGlobalProjectRegistry({ home });
    assert.equal(registry.state.operations.terminalize({
      operationId: first.payload.operation.operationId,
      workflowState: "SUCCEEDED",
      resultRef: "provider-result:terminal-replay",
    }).ok, true);

    const handler = createCodexHookHandler({ registry });
    const replay = await handler.handle(payload, { cwd });
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, "CODEX_TOOL_OPERATION_NOT_REPLAYABLE");
    assert.equal(replay.liveness, "TERMINAL");
    assert.equal(replay.projectId, registered.projectId);
  } finally {
    registry?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("replaying a correlated mutation after its provider-event deadline requires recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-hook-pretool-stale-replay-"));
  const home = join(root, "home");
  let registry;
  try {
    const { cwd, project: registered } = await prepareRegisteredWorkspace({ root, home });
    await invokeHook({ home, cwd, payload: { hook_event_name: "SessionStart", session_id: "stale-replay" } });
    const payload = {
      hook_event_name: "PreToolUse",
      session_id: "stale-replay",
      tool_name: "write_file",
      tool_call_id: "stale-replay-call",
      cwd,
    };
    const first = await invokeHook({ home, cwd, payload });
    assert.equal(first.code, 0);
    registry = createGlobalProjectRegistry({ home });
    const operation = registry.state.operations.inspect(first.payload.operation.operationId);
    const afterDeadline = new Date(Date.parse(operation.deadlineAt) + 1_000).toISOString();
    const handler = createCodexHookHandler({ registry, now: () => afterDeadline });
    const replay = await handler.handle(payload, { cwd });
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, "STALE_OPERATION_RECOVERY_REQUIRED");
    assert.equal(replay.liveness, "STALE_RECOVERABLE");
    assert.equal(replay.projectId, registered.projectId);
  } finally {
    registry?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("PostToolUse terminalizes only its correlated Operation and duplicate events converge", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-hook-posttool-terminalize-"));
  const home = join(root, "home");
  try {
    const { cwd, project: registered } = await prepareRegisteredWorkspace({ root, home });
    const session = "posttool-session";
    const callId = "posttool-call";
    await invokeHook({ home, cwd, payload: { hook_event_name: "SessionStart", session_id: session } });
    const before = await invokeHook({
      home, cwd,
      payload: { hook_event_name: "PreToolUse", session_id: session, tool_name: "write_file", tool_call_id: callId, cwd },
    });
    assert.equal(before.code, 0);

    const post = {
      hook_event_name: "PostToolUse",
      session_id: session,
      tool_name: "write_file",
      tool_call_id: callId,
      is_error: false,
      tool_response: "done",
      cwd,
    };
    const completed = await invokeHook({ home, cwd, payload: post });
    assert.equal(completed.code, 0);
    assert.equal(completed.payload.reason, null);
    assert.equal(completed.payload.operation.operationId, before.payload.operation.operationId);
    assert.equal(completed.payload.operation.workflowState, "SUCCEEDED");
    assert.equal(completed.payload.replayed, false);

    const replay = await invokeHook({ home, cwd, payload: post });
    assert.equal(replay.code, 0);
    assert.equal(replay.payload.operation.operationId, before.payload.operation.operationId);
    assert.equal(replay.payload.operation.workflowState, "SUCCEEDED");
    assert.equal(replay.payload.replayed, true);

    const state = createSqliteState({ dbPath: join(home, "state", "orchestra.db") });
    try {
      const terminal = state.operations.inspect(before.payload.operation.operationId);
      assert.equal(terminal.projectId, registered.projectId);
      assert.equal(terminal.liveness, "TERMINAL");
      assert.equal(terminal.workflowState, "SUCCEEDED");
      assert.equal(JSON.stringify(terminal).includes(callId), false);
      assert.equal(JSON.stringify(terminal).includes(session), false);
      assert.equal(JSON.stringify(terminal).includes("done"), false);
    } finally {
      state.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PostToolUse failure remains factual and missing or mismatched correlation cannot terminalize a writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-hook-posttool-mismatch-"));
  const home = join(root, "home");
  try {
    const { cwd, project: registered } = await prepareRegisteredWorkspace({ root, home });
    const session = "posttool-failure-session";
    const callId = "posttool-failure-call";
    await invokeHook({ home, cwd, payload: { hook_event_name: "SessionStart", session_id: session } });
    const before = await invokeHook({
      home, cwd,
      payload: { hook_event_name: "PreToolUse", session_id: session, tool_name: "write_file", tool_call_id: callId, cwd },
    });
    assert.equal(before.code, 0);

    const missing = await invokeHook({
      home, cwd,
      payload: {
        hook_event_name: "PostToolUse", session_id: session,
        tool_name: "write_file", tool_call_id: "missing-posttool-call", is_error: false, cwd,
      },
    });
    assert.equal(missing.code, 1);
    assert.equal(missing.payload.reason, "CODEX_TOOL_OPERATION_NOT_FOUND");

    const wrongActor = await invokeHook({
      home, cwd,
      payload: {
        hook_event_name: "PostToolUse", session_id: "different-session",
        tool_name: "write_file", tool_call_id: callId, is_error: false, cwd,
      },
    });
    assert.equal(wrongActor.code, 1);
    assert.equal(wrongActor.payload.reason, "CODEX_PROVIDER_EVENT_MISMATCH");

    const unclassified = await invokeHook({
      home, cwd,
      payload: {
        hook_event_name: "PostToolUse", session_id: session,
        tool_name: "write_file", tool_call_id: callId, tool_response: "no explicit outcome", cwd,
      },
    });
    assert.equal(unclassified.code, 1);
    assert.equal(unclassified.payload.reason, "CODEX_TOOL_RESULT_INVALID");

    const contradictory = await invokeHook({
      home, cwd,
      payload: {
        hook_event_name: "PostToolUse", session_id: session,
        tool_name: "write_file", tool_call_id: callId, is_error: false, exit_code: 1, cwd,
      },
    });
    assert.equal(contradictory.code, 1);
    assert.equal(contradictory.payload.reason, "CODEX_TOOL_RESULT_INVALID");

    const failed = await invokeHook({
      home, cwd,
      payload: {
        hook_event_name: "PostToolUse", session_id: session,
        tool_name: "write_file", tool_call_id: callId, exit_code: 1, tool_response: "tool failed", cwd,
      },
    });
    assert.equal(failed.code, 0);
    assert.equal(failed.payload.operation.operationId, before.payload.operation.operationId);
    assert.equal(failed.payload.operation.workflowState, "FAILED");

    const state = createSqliteState({ dbPath: join(home, "state", "orchestra.db") });
    try {
      const terminal = state.operations.inspect(before.payload.operation.operationId);
      assert.equal(terminal.projectId, registered.projectId);
      assert.equal(terminal.liveness, "TERMINAL");
      assert.equal(terminal.workflowState, "FAILED");
      assert.equal(terminal.resultRef.includes("failed"), true);
      assert.equal(JSON.stringify(terminal).includes("tool failed"), false);
      assert.equal(JSON.stringify(terminal).includes(callId), false);
    } finally {
      state.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PostToolUse rejects changed Work identity or generation without terminalizing the tracked Operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-hook-posttool-work-mismatch-"));
  const home = join(root, "home");
  try {
    const { cwd, project: registered } = await prepareRegisteredWorkspace({ root, home });
    const session = "posttool-work-session";
    const callId = "posttool-work-call";
    await invokeHook({ home, cwd, payload: { hook_event_name: "SessionStart", session_id: session } });
    const before = await invokeHook({
      home, cwd,
      payload: { hook_event_name: "PreToolUse", session_id: session, tool_name: "write_file", tool_call_id: callId, cwd },
    });
    assert.equal(before.code, 0);

    const state = createSqliteState({ dbPath: join(home, "state", "orchestra.db") });
    try {
      assert.equal(state.work.open(work("work-other", registered.projectId)).ok, true);
      const changedWork = state.sessionObservations.put({
        provider: "codex",
        projectId: registered.projectId,
        actorIdHash: hash(session),
        observedInstructionEpoch: 7,
        observedWorkId: "work-other",
        observedGeneration: 3,
        observedAt: "2099-10-17T10:01:00.000Z",
      });
      assert.equal(changedWork.ok, true);
    } finally {
      state.close();
    }

    const mismatchedWork = await invokeHook({
      home, cwd,
      payload: {
        hook_event_name: "PostToolUse", session_id: session,
        tool_name: "write_file", tool_call_id: callId, is_error: false, cwd,
      },
    });
    assert.equal(mismatchedWork.code, 1);
    assert.equal(mismatchedWork.payload.reason, "CODEX_PROVIDER_EVENT_MISMATCH");

    const updateState = createSqliteState({ dbPath: join(home, "state", "orchestra.db") });
    try {
      const changedGeneration = updateState.sessionObservations.put({
        provider: "codex",
        projectId: registered.projectId,
        actorIdHash: hash(session),
        observedInstructionEpoch: 7,
        observedWorkId: "work-other",
        observedGeneration: 4,
        observedAt: "2099-10-17T10:02:00.000Z",
      });
      assert.equal(changedGeneration.ok, true);
    } finally {
      updateState.close();
    }

    const mismatchedGeneration = await invokeHook({
      home, cwd,
      payload: {
        hook_event_name: "PostToolUse", session_id: session,
        tool_name: "write_file", tool_call_id: callId, is_error: false, cwd,
      },
    });
    assert.equal(mismatchedGeneration.code, 1);
    assert.equal(mismatchedGeneration.payload.reason, "CODEX_PROVIDER_EVENT_MISMATCH");

    const check = createSqliteState({ dbPath: join(home, "state", "orchestra.db") });
    try {
      const operation = check.operations.inspect(before.payload.operation.operationId);
      assert.equal(operation.liveness, "LIVE");
      assert.equal(operation.workflowState, "RUNNING");
    } finally {
      check.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PostToolUse rejects contradictory or mis-scoped correlation-store results", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-hook-posttool-project-mismatch-"));
  const home = join(root, "home");
  const registry = createGlobalProjectRegistry({ home });
  try {
    const workspaceA = await makeWorkspace(join(root, "a"));
    const workspaceB = await makeWorkspace(join(root, "b"));
    const registeredA = await registry.registerWorkspace({ root: workspaceA, runtimeImage: "2.0.0", instructionEpoch: 7, trustMode: "trusted" });
    const registeredB = await registry.registerWorkspace({ root: workspaceB, runtimeImage: "2.0.0", instructionEpoch: 7, trustMode: "trusted" });
    assert.equal(registeredA.ok, true);
    assert.equal(registeredB.ok, true);
    assert.equal(registry.state.work.startCurrent(work("work-project-a", registeredA.project.projectId)).ok, true);
    assert.equal(registry.state.work.startCurrent(work("work-project-b", registeredB.project.projectId)).ok, true);

    const session = "project-mismatch-session";
    const callId = "same-project-scoped-call";
    await invokeHook({ home, cwd: workspaceA, payload: { hook_event_name: "SessionStart", session_id: session } });
    await invokeHook({ home, cwd: workspaceB, payload: { hook_event_name: "SessionStart", session_id: session } });
    const pre = await invokeHook({
      home, cwd: workspaceA,
      payload: { hook_event_name: "PreToolUse", session_id: session, tool_name: "write_file", tool_call_id: callId, cwd: workspaceA },
    });
    assert.equal(pre.code, 0);
    const correlation = registry.state.operationCorrelations.get({
      provider: "codex", projectId: registeredA.project.projectId, correlationHash: hash(callId),
    });
    assert.ok(correlation);

    const facadeFor = (get) => ({
      paths: registry.paths,
      resolveWorkspace: registry.resolveWorkspace.bind(registry),
      state: { ...registry.state, operationCorrelations: { get } },
    });
    await invokeHook({ home, cwd: workspaceB, payload: { hook_event_name: "SessionStart", session_id: session } });
    const post = {
      hook_event_name: "PostToolUse", session_id: session,
      tool_name: "write_file", tool_call_id: callId, is_error: false,
    };
    const misScoped = await createCodexHookHandler({ registry: facadeFor(() => correlation) })
      .handle({ ...post, cwd: workspaceB }, { cwd: workspaceB });
    assert.equal(misScoped.reason, "CODEX_PROVIDER_EVENT_MISMATCH");

    const ambiguous = await createCodexHookHandler({
      registry: facadeFor(() => [correlation, { ...correlation, operationId: "op-contradictory" }]),
    }).handle({ ...post, cwd: workspaceA }, { cwd: workspaceA });
    assert.equal(ambiguous.reason, "CODEX_TOOL_OPERATION_AMBIGUOUS");
    assert.equal(registry.state.operations.inspect(pre.payload.operation.operationId).liveness, "LIVE");
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("PostToolUse rejects conflicting result aliases without terminalizing either Operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-hook-posttool-result-aliases-"));
  const home = join(root, "home");
  try {
    const workspaceA = await makeWorkspace(join(root, "a"));
    const workspaceB = await makeWorkspace(join(root, "b"));
    const registry = createGlobalProjectRegistry({ home });
    let projectA;
    let projectB;
    try {
      const registeredA = await registry.registerWorkspace({ root: workspaceA, runtimeImage: "2.0.0", instructionEpoch: 7, trustMode: "trusted" });
      const registeredB = await registry.registerWorkspace({ root: workspaceB, runtimeImage: "2.0.0", instructionEpoch: 7, trustMode: "trusted" });
      assert.equal(registeredA.ok, true);
      assert.equal(registeredB.ok, true);
      projectA = registeredA.project;
      projectB = registeredB.project;
      assert.equal(registry.state.work.startCurrent(work("work-alias-a", projectA.projectId)).ok, true);
      assert.equal(registry.state.work.startCurrent(work("work-alias-b", projectB.projectId)).ok, true);
    } finally {
      registry.close();
    }

    const session = "result-alias-session";
    const callA = "result-alias-error-call";
    const callB = "result-alias-exit-call";
    for (const [cwd, callId] of [[workspaceA, callA], [workspaceB, callB]]) {
      await invokeHook({ home, cwd, payload: { hook_event_name: "SessionStart", session_id: session } });
      const pre = await invokeHook({
        home, cwd,
        payload: { hook_event_name: "PreToolUse", session_id: session, tool_name: "write_file", tool_call_id: callId, cwd },
      });
      assert.equal(pre.code, 0);
    }

    const contradictoryError = await invokeHook({
      home, cwd: workspaceA,
      payload: {
        hook_event_name: "PostToolUse", session_id: session,
        tool_name: "write_file", tool_call_id: callA, is_error: false, isError: true, cwd: workspaceA,
      },
    });
    const contradictoryExit = await invokeHook({
      home, cwd: workspaceB,
      payload: {
        hook_event_name: "PostToolUse", session_id: session,
        tool_name: "write_file", tool_call_id: callB, exit_code: 0, exitCode: 1, cwd: workspaceB,
      },
    });
    assert.equal(contradictoryError.code, 1);
    assert.equal(contradictoryError.payload.reason, "CODEX_TOOL_RESULT_INVALID");
    assert.equal(contradictoryExit.code, 1);
    assert.equal(contradictoryExit.payload.reason, "CODEX_TOOL_RESULT_INVALID");

    const state = createSqliteState({ dbPath: join(home, "state", "orchestra.db") });
    try {
      assert.equal(state.operations.listLive({ projectId: projectA.projectId }).length, 1);
      assert.equal(state.operations.listLive({ projectId: projectB.projectId }).length, 1);
    } finally {
      state.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PostToolUse read-only results are a successful no-op and preserve a different live writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-hook-posttool-readonly-"));
  const home = join(root, "home");
  try {
    const { cwd, project: registered } = await prepareRegisteredWorkspace({ root, home });
    const session = "posttool-readonly-session";
    await invokeHook({ home, cwd, payload: { hook_event_name: "SessionStart", session_id: session } });
    const writer = await invokeHook({
      home, cwd,
      payload: { hook_event_name: "PreToolUse", session_id: session, tool_name: "write_file", tool_call_id: "live-writer-call", cwd },
    });
    assert.equal(writer.code, 0);

    const readResult = await invokeHook({
      home, cwd,
      payload: {
        hook_event_name: "PostToolUse", session_id: session,
        tool_name: "read_file", tool_call_id: "read-result-call", is_error: false, cwd,
      },
    });
    assert.equal(readResult.code, 0);
    assert.equal(readResult.payload.reason, null);
    assert.equal(readResult.payload.operation, undefined);

    const state = createSqliteState({ dbPath: join(home, "state", "orchestra.db") });
    try {
      const live = state.operations.listLive({ projectId: registered.projectId });
      assert.equal(live.length, 1);
      assert.equal(live[0].operationId, writer.payload.operation.operationId);
      assert.equal(live[0].workflowState, "RUNNING");
    } finally {
      state.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
