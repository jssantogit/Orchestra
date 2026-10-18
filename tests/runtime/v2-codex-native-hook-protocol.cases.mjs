import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { runGlobalCli } from "../../v2/global/cli.mjs";
import { createGlobalProjectRegistry } from "../../v2/global/project-registry.mjs";
import { normalizeCodexActor } from "../../v2/providers/codex/actor.mjs";
import { normalizeCodexToolEvent } from "../../v2/providers/codex/tool-event.mjs";

function work(workId, project) {
  return {
    schema: "orchestra.work-unit.v2",
    workId,
    projectId: project.projectId,
    taskId: `task-${workId}`,
    generation: 1,
    runtimeImage: project.runtime.pinnedImage,
    instructionEpoch: project.runtime.instructionEpoch,
    state: "INTAKE",
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
  };
}

async function makeWorkspace(root) {
  const cwd = join(root, "workspace");
  await mkdir(cwd, { recursive: true });
  execFileSync("git", ["init", "--quiet", cwd]);
  return cwd;
}

async function prepareRegisteredWorkspace({ root, home }) {
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
    assert.equal(registry.state.work.startCurrent(work("work-native-hook", registered.project)).ok, true);
    return { cwd, project: registered.project };
  } finally {
    registry.close();
  }
}

async function invokeHook({ home, cwd, payload }) {
  let stdout = "";
  let stderr = "";
  const code = await runGlobalCli({
    argv: ["provider", "codex", "hook"],
    cwd,
    env: { ORCHESTRA_HOME: home },
    stdin: Readable.from([JSON.stringify({ ...payload, cwd })]),
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  });
  return { code, payload: JSON.parse(stdout || stderr) };
}

async function withActiveWorkspace(fn) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-codex-native-hook-"));
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareRegisteredWorkspace({ root, home });
    await fn({ home, cwd, project });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Codex native tool_use_id is the factual tool correlation id", () => {
  const normalized = normalizeCodexToolEvent({
    hook_event_name: "PreToolUse",
    session_id: "native-correlation-session",
    tool_name: "apply_patch",
    tool_use_id: "native-tool-use-1",
    tool_input: { command: "*** Begin Patch\n*** End Patch" },
  });
  assert.equal(normalized.factualIds.toolCallId, "native-tool-use-1");

  assert.throws(() => normalizeCodexToolEvent({
    hook_event_name: "PreToolUse",
    session_id: "native-correlation-session",
    tool_name: "apply_patch",
    tool_use_id: "native-tool-use-1",
    tool_call_id: "legacy-conflict",
  }), { code: "CODEX_TOOL_CORRELATION_INVALID" });
});

test("native Codex apply_patch begins and terminalizes one durable Operation", async () => {
  await withActiveWorkspace(async ({ home, cwd }) => {
    const session_id = "native-apply-patch-session";
    const tool_use_id = "native-apply-patch-call";
    const tool_input = { command: "*** Begin Patch\n*** Add File: field.txt\n+field\n*** End Patch" };

    const attached = await invokeHook({ home, cwd, payload: { hook_event_name: "SessionStart", session_id } });
    assert.equal(attached.code, 0);
    assert.equal(attached.payload.ok, true);

    const before = await invokeHook({
      home,
      cwd,
      payload: { hook_event_name: "PreToolUse", session_id, tool_name: "apply_patch", tool_use_id, tool_input },
    });
    assert.equal(before.code, 0);
    assert.equal(before.payload.ok, true);
    assert.equal(before.payload.hookSpecificOutput.permissionDecision, "allow");
    assert.equal(typeof before.payload.operation?.operationId, "string");

    let registry = createGlobalProjectRegistry({ home });
    const begun = registry.state.operations.inspect(before.payload.operation.operationId);
    assert.equal(begun.workflowState, "RUNNING");
    assert.equal(begun.liveness, "LIVE");
    registry.close();

    const after = await invokeHook({
      home,
      cwd,
      payload: {
        hook_event_name: "PostToolUse",
        session_id,
        tool_name: "apply_patch",
        tool_use_id,
        tool_input,
        tool_response: "Done!",
      },
    });
    assert.equal(after.code, 0);
    assert.equal(after.payload.ok, true);
    assert.equal(after.payload.operation.workflowState, "SUCCEEDED");
    assert.equal(after.payload.operation.liveness, "TERMINAL");

    registry = createGlobalProjectRegistry({ home });
    const terminal = registry.state.operations.inspect(before.payload.operation.operationId);
    assert.equal(terminal.workflowState, "SUCCEEDED");
    assert.equal(terminal.liveness, "TERMINAL");
    registry.close();
  });
});

test("native Codex Bash result without factual exit status closes UNKNOWN instead of inventing success", async () => {
  await withActiveWorkspace(async ({ home, cwd }) => {
    const session_id = "native-bash-session";
    const tool_use_id = "native-bash-call";
    const tool_input = { command: "node -e \"process.exit(0)\"" };

    const attached = await invokeHook({ home, cwd, payload: { hook_event_name: "SessionStart", session_id } });
    assert.equal(attached.payload.ok, true);

    const before = await invokeHook({
      home,
      cwd,
      payload: { hook_event_name: "PreToolUse", session_id, tool_name: "Bash", tool_use_id, tool_input },
    });
    assert.equal(before.payload.ok, true);

    const after = await invokeHook({
      home,
      cwd,
      payload: {
        hook_event_name: "PostToolUse",
        session_id,
        tool_name: "Bash",
        tool_use_id,
        tool_input,
        tool_response: "",
      },
    });
    assert.equal(after.code, 0);
    assert.equal(after.payload.ok, true);
    assert.equal(after.payload.operation.workflowState, "UNKNOWN");
    assert.equal(after.payload.operation.liveness, "TERMINAL");
  });
});

test("native Codex stale epoch denial exits zero through CLI and installed shim", async () => {
  await withActiveWorkspace(async ({ home, cwd, project }) => {
    const session_id = "native-stale-epoch-session";
    const tool_use_id = "native-stale-epoch-call";
    const actor = normalizeCodexActor({ session_id });
    let registry = createGlobalProjectRegistry({ home });
    try {
      const observed = registry.state.sessionObservations.put({
        provider: "codex",
        projectId: project.projectId,
        actorIdHash: actor.actorIdHash,
        observedInstructionEpoch: project.runtime.instructionEpoch - 1,
        observedWorkId: "work-native-hook",
        observedGeneration: 1,
        observedAt: "2026-10-18T02:00:00.000Z",
      });
      assert.equal(observed.ok, true);
    } finally {
      registry.close();
    }

    const payload = {
      hook_event_name: "PreToolUse",
      session_id,
      tool_name: "apply_patch",
      tool_use_id,
      tool_input: { command: "*** Begin Patch\n*** Add File: forbidden.txt\n+forbidden\n*** End Patch" },
    };
    const direct = await invokeHook({ home, cwd, payload });
    assert.equal(direct.code, 0);
    assert.equal(direct.payload.ok, false);
    assert.equal(direct.payload.reason, "SESSION_RUNTIME_STALE");
    assert.equal(direct.payload.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(direct.payload.hookSpecificOutput.permissionDecision, "deny");

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
    const forwarded = spawnSync(process.execPath, [shimPath], {
      cwd,
      env: shimEnv,
      input: JSON.stringify({ ...payload, cwd }),
      encoding: "utf8",
    });
    assert.equal(forwarded.status, 0);
    assert.equal(forwarded.stderr, "");
    const response = JSON.parse(forwarded.stdout);
    assert.equal(response.reason, "SESSION_RUNTIME_STALE");
    assert.equal(response.hookSpecificOutput.permissionDecision, "deny");

    registry = createGlobalProjectRegistry({ home });
    try {
      assert.deepEqual(registry.state.operations.listLive({ projectId: project.projectId }), []);
    } finally {
      registry.close();
    }
  });
});
