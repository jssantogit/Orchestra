import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";
import { createGlobalProjectRegistry } from "../../v2/global/project-registry.mjs";
import { runGlobalCli } from "../../v2/global/cli.mjs";
import { createRuntimeOwnerStore } from "../../v2/liveness/runtime-owner-store.mjs";
import { createProviderEventProbe } from "../../v2/liveness/provider-event-liveness.mjs";
import { createOperationLivenessService } from "../../v2/liveness/operation-liveness-service.mjs";
import { createHostProcessIdentityReader, createLocalProcessOwnerProbe } from "../../v2/liveness/local-process-probe.mjs";
import { createAntigravityHookHandler } from "../../v2/providers/antigravity/hook-handler.mjs";
import { createWorkAuthority } from "../../v2/authority/work-authority.mjs";
import { createAntigravityProcessExecution } from "../../v2/providers/antigravity/process-execution.mjs";
import {
  buildAntigravityV2ShimArtifacts,
  installAntigravityV2Shim,
} from "../../v2/providers/antigravity/shim-manager.mjs";
import { createAntigravityDelegationExecutor } from "../../providers/antigravity/delegation-executor.mjs";

import { normalizeAntigravityActor } from "../../v2/providers/antigravity/actor.mjs";
import { normalizeAntigravityToolEvent } from "../../v2/providers/antigravity/tool-event.mjs";

function hashId(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

test("factual Antigravity root identity becomes hashed provider provenance", () => {
  const actor = normalizeAntigravityActor({ conversation_id: "agy-root-01" });

  assert.deepEqual(actor, {
    provider: "antigravity",
    actorKind: "ROOT",
    actorIdHash: hashId("agy-root-01"),
    isRoot: true,
  });
  assert.equal(JSON.stringify(actor).includes("agy-root-01"), false);
});

test("Antigravity identity hashes the exact provider-supplied bytes", () => {
  const actor = normalizeAntigravityActor({ conversationId: " agy-root-01 " });

  assert.equal(actor.actorIdHash, hashId(" agy-root-01 "));
  assert.notEqual(actor.actorIdHash, hashId("agy-root-01"));
});

test("factual child identity stays distinct and retains factual parent provenance", () => {
  const actor = normalizeAntigravityActor({
    conversationId: "agy-child-01",
    parentConversationId: "agy-root-01",
  });

  assert.deepEqual(actor, {
    provider: "antigravity",
    actorKind: "CHILD",
    actorIdHash: hashId("agy-child-01"),
    parentActorIdHash: hashId("agy-root-01"),
    isRoot: false,
  });
  assert.notEqual(actor.actorIdHash, actor.parentActorIdHash);
});

test("missing or contradictory Antigravity identity aliases fail closed", () => {
  for (const payload of [
    {},
    { conversationId: "" },
    { conversationId: "agy-one", conversation_id: "agy-two" },
    { conversationId: "agy-child", parentConversationId: "agy-parent", parent_conversation_id: "other-parent" },
    { conversationId: "agy-child", parentConversationId: "" },
  ]) {
    assert.throws(() => normalizeAntigravityActor(payload), (error) => {
      assert.equal(error.code, "ANTIGRAVITY_PROVIDER_IDENTITY_INVALID");
      return true;
    });
  }
});

test("role and profile metadata do not change factual root identity", () => {
  const actor = normalizeAntigravityActor({
    conversationId: "agy-root-01",
    role: "SUBAGENT",
    profile: "arbitrary-profile",
  });

  assert.equal(actor.actorKind, "ROOT");
  assert.equal(actor.actorIdHash, hashId("agy-root-01"));
});

test("environment data never supplies missing Antigravity provider identity", () => {
  assert.throws(
    () => normalizeAntigravityActor({}, { conversation_id: "environment-inferred" }),
    (error) => error.code === "ANTIGRAVITY_PROVIDER_IDENTITY_INVALID",
  );
});

test("Antigravity read, write, and command tools map to neutral event classes", () => {
  const identity = { conversationId: "agy-root-01" };
  const read = normalizeAntigravityToolEvent({
    ...identity,
    eventType: "PreToolUse",
    toolCall: { name: "read_file", args: { path: "src/main.mjs" } },
  });
  const write = normalizeAntigravityToolEvent({
    ...identity,
    eventType: "PreToolUse",
    toolCall: { name: "write_file", args: { path: "src/main.mjs" } },
  });
  const command = normalizeAntigravityToolEvent({
    ...identity,
    hook_event_name: "PreToolUse",
    tool_name: "run_command",
  });

  assert.deepEqual([read.operation, read.sideEffectClass], ["READ", "READ_ONLY"]);
  assert.deepEqual([write.operation, write.sideEffectClass], ["WRITE", "WORKSPACE_MUTATION"]);
  assert.deepEqual([command.operation, command.sideEffectClass], ["COMMAND", "UNKNOWN"]);
});

test("unknown side-effecting Antigravity tools remain mutation-protected", () => {
  const event = normalizeAntigravityToolEvent({
    conversationId: "agy-root-01",
    eventType: "PreToolUse",
    toolCall: { name: "unknown_write_everything", args: { path: "secret.txt" } },
  });

  assert.equal(event.operation, "UNKNOWN");
  assert.equal(event.sideEffectClass, "UNKNOWN");
});

test("Antigravity tool correlation preserves factual IDs without truncation or invention", () => {
  const longId = ` call-${"x".repeat(700)} `;
  const event = normalizeAntigravityToolEvent({
    conversation_id: "agy-root-01",
    eventType: "PreToolUse",
    toolCall: { id: longId, name: "write_file" },
  });

  assert.equal(event.factualIds.toolCallId, longId);
  assert.equal(Object.hasOwn(normalizeAntigravityToolEvent({
    conversation_id: "agy-root-01",
    eventType: "PreToolUse",
    toolCall: { name: "write_file" },
  }).factualIds, "toolCallId"), false);
});

test("contradictory Antigravity tool correlation aliases fail closed", () => {
  assert.throws(() => normalizeAntigravityToolEvent({
    conversation_id: "agy-root-01",
    tool_call_id: "call-one",
    toolCallId: "call-two",
    eventType: "PreToolUse",
    toolCall: { name: "write_file" },
  }), (error) => error.code === "ANTIGRAVITY_TOOL_CORRELATION_INVALID");
});

function v2Project(projectId, canonicalRoot) {
  return {
    schema: "orchestra.project.v2",
    projectId,
    lineageId: `lineage-${projectId}`,
    workspace: { canonicalRoot, vcs: "git" },
    runtime: { pinnedImage: "2.0.0", instructionEpoch: 7 },
    trust: { mode: "trusted" },
  };
}

function v2Work(workId, projectId, instructionEpoch = 7) {
  return {
    schema: "orchestra.work-unit.v2",
    workId,
    projectId,
    taskId: `task-${workId}`,
    generation: 3,
    runtimeImage: "2.0.0",
    instructionEpoch,
    state: "INTAKE",
    scopeRef: null,
    directionRef: null,
    candidateRef: null,
    evidenceRefs: [],
    blockers: [],
    continuationRef: null,
  };
}

async function makeGitWorkspace(root, name = "workspace") {
  const workspace = join(root, name);
  await mkdir(workspace, { recursive: true });
  execFileSync("git", ["init", "--quiet", workspace]);
  return workspace;
}

async function prepareProject({ root, home, active = true, workspaceName = "workspace", workId = "work-antigravity" }) {
  const cwd = await makeGitWorkspace(root, workspaceName);
  const registry = createGlobalProjectRegistry({ home });
  try {
    const registered = await registry.registerWorkspace({
      root: cwd,
      runtimeImage: "2.0.0",
      instructionEpoch: 7,
      trustMode: "trusted",
    });
    assert.equal(registered.ok, true);
    if (active) {
      assert.equal(registry.state.work.startCurrent(
        v2Work(workId, registered.project.projectId),
      ).ok, true);
    }
    return { cwd, project: registered.project };
  } finally {
    registry.close();
  }
}

async function invokeAntigravityHook({ home, cwd, payload }) {
  let stdout = "";
  let stderr = "";
  const code = await runGlobalCli({
    argv: ["provider", "antigravity", "hook"],
    cwd,
    env: { ORCHESTRA_HOME: home },
    stdin: Readable.from([JSON.stringify(payload)]),
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  });
  return { code, payload: JSON.parse(stdout || stderr) };
}

function actorHash(conversationId) {
  return hashId(conversationId);
}

for (const active of [true, false]) {
  test(`PreInvocation attaches and refreshes the factual actor with ${active ? "current Work" : "INTAKE"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestra-agy-invocation-"));
    try {
      const home = join(root, "home");
      const { cwd, project } = await prepareProject({ root, home, active });
      const conversationId = "factual-invocation-conversation";
      let previous = null;
      for (const invocationNum of [0, 1, 17]) {
        const attached = await invokeAntigravityHook({ home, cwd, payload: {
          hookEventName: "PreInvocation", conversationId, workspacePaths: [cwd], invocationNum, initialNumSteps: 0,
        } });
        assert.equal(attached.code, 0, JSON.stringify(attached.payload));
        assert.equal(attached.payload.hookSpecificOutput.hookEventName, "PreInvocation");
        const registry = createGlobalProjectRegistry({ home });
        try {
          const observation = registry.state.sessionObservations.get({ provider: "antigravity", projectId: project.projectId, actorIdHash: actorHash(conversationId) });
          assert.equal(observation.observedWorkId, active ? "work-antigravity" : null);
          assert.equal(observation.observedGeneration, active ? 3 : null);
          assert.equal(observation.observedInstructionEpoch, 7);
          assert.equal(registry.state.operations.listLive({ projectId: project.projectId }).length, 0);
          if (previous) assert.ok(observation.observedAt >= previous.observedAt);
          previous = observation;
        } finally { registry.close(); }
      }
      const other = await prepareProject({ root, home, workspaceName: "other", active: false });
      const denied = await invokeAntigravityHook({ home, cwd: other.cwd, payload: {
        hookEventName: "PreToolUse", conversationId, toolCall: { id: "cross-project-write", name: "write_file" },
      } });
      assert.equal(denied.payload.ok, false);
      assert.equal(denied.payload.hookSpecificOutput.permissionDecision, "deny");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("PreInvocation refreshes after official Work replacement without bypassing stale Work fencing", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-agy-refresh-"));
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareProject({ root, home });
    const conversationId = "refresh-current-work";
    const attach = (hookEventName) => invokeAntigravityHook({ home, cwd, payload: { hookEventName, conversationId, invocationNum: 9 } });
    assert.equal((await attach("PreInvocation")).code, 0);
    const registry = createGlobalProjectRegistry({ home });
    try {
      const authority = createWorkAuthority({ state: registry.state });
      assert.equal(authority.abandon({ projectId: project.projectId, expectedWorkId: "work-antigravity", expectedGeneration: 3, commandId: "replace-current-work", reason: "test official replacement" }).ok, true);
      assert.equal(authority.start(v2Work("replacement-work", project.projectId)).ok, true);
    } finally { registry.close(); }
    const denied = await invokeAntigravityHook({ home, cwd, payload: { hookEventName: "PreToolUse", conversationId, toolCall: { id: "old-work-write", name: "write_file" } } });
    assert.equal(denied.payload.ok, false);
    assert.equal(denied.payload.reason, "STALE_ACTIVE_WORK");
    assert.equal((await attach("PreInvocation")).code, 0);
    assert.equal((await attach("SessionStart")).code, 0);
    const reopened = createGlobalProjectRegistry({ home });
    try {
      const observation = reopened.state.sessionObservations.get({ provider: "antigravity", projectId: project.projectId, actorIdHash: actorHash(conversationId) });
      assert.equal(observation.observedWorkId, "replacement-work");
      assert.equal(observation.observedGeneration, 3);
      assert.equal(reopened.state.operations.listLive({ projectId: project.projectId }).length, 0);
    } finally { reopened.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("PreInvocation refreshes an officially upgraded epoch while old observations remain fenced", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-agy-epoch-refresh-"));
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareProject({ root, home });
    const invoke = async (argv) => {
      let output = "";
      const code = await runGlobalCli({ argv, cwd, env: { ORCHESTRA_HOME: home }, stdout: { write: (chunk) => { output += chunk; } }, stderr: { write: (chunk) => { output += chunk; } } });
      assert.equal(code, 0, output);
      return JSON.parse(output);
    };
    for (const conversationId of ["refresh-epoch", "remain-stale"]) {
      assert.equal((await invokeAntigravityHook({ home, cwd, payload: { hookEventName: "PreInvocation", conversationId } })).code, 0);
    }
    const sourcePath = join(root, "runtime.json");
    await writeFile(sourcePath, JSON.stringify({ schema: "orchestra.runtime-image-source.v2", version: "2.1.0", engineCompatibility: { min: "2.0.0", max: "2.x" }, providerAdapterCompatibility: { codex: { min: "2.0.0", max: "2.x" }, antigravity: { min: "2.0.0", max: "2.x" } }, files: [{ path: "runtime/instructions.txt", contentBase64: Buffer.from("epoch refresh test").toString("base64") }] }));
    const installed = await invoke(["runtime", "install", sourcePath]);
    const beforeUpgrade = createGlobalProjectRegistry({ home });
    try {
      assert.equal(createWorkAuthority({ state: beforeUpgrade.state }).abandon({ projectId: project.projectId, expectedWorkId: "work-antigravity", expectedGeneration: 3, commandId: "quiesce-for-epoch-upgrade", reason: "official upgrade precondition" }).ok, true);
    } finally { beforeUpgrade.close(); }
    const upgraded = await invoke(["project", "upgrade", project.projectId, "--runtime-image", installed.image.imageId, "--command-id", "agy-official-epoch-upgrade"]);
    assert.equal(upgraded.instructionEpoch, 8);
    const afterUpgrade = createGlobalProjectRegistry({ home });
    try {
      assert.equal(createWorkAuthority({ state: afterUpgrade.state }).start({ ...v2Work("upgraded-work", project.projectId, 8), runtimeImage: installed.image.imageId }).ok, true);
    } finally { afterUpgrade.close(); }
    for (const conversationId of ["refresh-epoch", "remain-stale"]) {
      const denied = await invokeAntigravityHook({ home, cwd, payload: { hookEventName: "PreToolUse", conversationId, toolCall: { id: `stale-${conversationId}`, name: "write_file" } } });
      assert.equal(denied.payload.reason, "SESSION_RUNTIME_STALE");
    }
    assert.equal((await invokeAntigravityHook({ home, cwd, payload: { hookEventName: "PreInvocation", conversationId: "refresh-epoch", invocationNum: 12 } })).code, 0);
    const registry = createGlobalProjectRegistry({ home });
    try {
      for (const [conversationId, expectedEpoch] of [["refresh-epoch", 8], ["remain-stale", 7]]) {
        assert.equal(registry.state.sessionObservations.get({ provider: "antigravity", projectId: project.projectId, actorIdHash: actorHash(conversationId) }).observedInstructionEpoch, expectedEpoch);
      }
    } finally { registry.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function startAntigravityMutation({ home, cwd, conversationId, toolCallId }) {
  const attached = await invokeAntigravityHook({
    home, cwd,
    payload: { hookEventName: "SessionStart", conversationId },
  });
  assert.equal(attached.code, 0);
  const started = await invokeAntigravityHook({
    home, cwd,
    payload: {
      hookEventName: "PreToolUse",
      conversationId,
      toolCall: { id: toolCallId, name: "write_file", args: { path: "src/main.mjs" } },
    },
  });
  return { attached, started };
}

function mutateObservation(state, { projectId, conversationId, ...updates }) {
  const current = state.sessionObservations.get({
    provider: "antigravity",
    projectId,
    actorIdHash: actorHash(conversationId),
  });
  assert.ok(current);
  const observedAt = new Date(Date.parse(current.observedAt) + 1_000).toISOString();
  return state.sessionObservations.put({ ...current, ...updates, observedAt });
}

test("Antigravity SessionStart attaches fresh conversations to the current Work", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-attach-"));
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareProject({ root, home });
    const sameProviderIdentity = "fresh-antigravity-1";
    const state = createSqliteState({ dbPath: join(home, "state", "orchestra.db") });
    try {
      const otherProviderObservation = state.sessionObservations.put({
        provider: "codex",
        projectId: project.projectId,
        actorIdHash: actorHash(sameProviderIdentity),
        observedInstructionEpoch: 7,
        observedWorkId: "work-antigravity",
        observedGeneration: 3,
        observedAt: "2026-10-17T10:00:00.000Z",
      });
      assert.equal(otherProviderObservation.ok, true);
    } finally {
      state.close();
    }

    const first = await invokeAntigravityHook({
      home, cwd,
      payload: { hookEventName: "SessionStart", conversationId: sameProviderIdentity },
    });
    const second = await invokeAntigravityHook({
      home, cwd,
      payload: { hookEventName: "SessionStart", conversationId: "fresh-antigravity-2" },
    });

    assert.equal(first.code, 0);
    assert.equal(first.payload.ok, true);
    assert.equal(first.payload.work.workId, "work-antigravity");
    assert.equal(first.payload.generation, 3);
    assert.equal(first.payload.hookSpecificOutput.hookEventName, "SessionStart");
    assert.equal(second.code, 0);
    assert.equal(second.payload.work.workId, "work-antigravity");

    const reopened = createGlobalProjectRegistry({ home });
    try {
      assert.equal(reopened.state.work.current(project.projectId).workId, "work-antigravity");
      for (const [provider, conversationId] of [
        ["antigravity", sameProviderIdentity],
        ["antigravity", "fresh-antigravity-2"],
        ["codex", sameProviderIdentity],
      ]) {
        const observation = reopened.state.sessionObservations.get({
          provider,
          projectId: project.projectId,
          actorIdHash: actorHash(conversationId),
        });
        assert.equal(observation.observedWorkId, "work-antigravity");
        assert.equal(observation.observedGeneration, 3);
      }
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity SessionStart stores null work and generation for INTAKE", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-intake-"));
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareProject({ root, home, active: false });
    const attached = await invokeAntigravityHook({
      home, cwd,
      payload: { hookEventName: "SessionStart", conversation_id: "intake-antigravity" },
    });

    assert.equal(attached.code, 0);
    assert.equal(attached.payload.reason, "ORCHESTRA_V2_INTAKE");
    assert.equal(attached.payload.work, null);
    assert.equal(attached.payload.generation, null);

    const registry = createGlobalProjectRegistry({ home });
    try {
      const observation = registry.state.sessionObservations.get({
        provider: "antigravity",
        projectId: project.projectId,
        actorIdHash: actorHash("intake-antigravity"),
      });
      assert.equal(observation.observedWorkId, null);
      assert.equal(observation.observedGeneration, null);
      assert.equal(observation.observedInstructionEpoch, 7);
    } finally {
      registry.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity SessionStart leaves an unregistered workspace unregistered", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-unregistered-"));
  try {
    const home = join(root, "home");
    const registered = await prepareProject({ root, home, active: false });
    const cwd = await makeGitWorkspace(root, "other-workspace");
    const denied = await invokeAntigravityHook({
      home, cwd,
      payload: { hookEventName: "SessionStart", conversationId: "unregistered-antigravity" },
    });

    assert.equal(denied.code, 1);
    assert.equal(denied.payload.reason, "PROJECT_NOT_REGISTERED");
    const registry = createGlobalProjectRegistry({ home });
    try {
      assert.equal(await registry.resolveWorkspace(cwd), null);
      assert.ok(await registry.resolveWorkspace(registered.cwd));
    } finally {
      registry.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity SessionStart preserves the neutral stale instruction epoch reason", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-stale-epoch-"));
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareProject({ root, home });
    const db = new DatabaseSync(join(home, "state", "orchestra.db"));
    try {
      const row = db.prepare("SELECT record_json FROM projects WHERE project_id = ?").get(project.projectId);
      const updatedProject = JSON.parse(row.record_json);
      updatedProject.runtime.instructionEpoch = 8;
      db.prepare("UPDATE projects SET record_json = ? WHERE project_id = ?")
        .run(JSON.stringify(updatedProject), project.projectId);
    } finally {
      db.close();
    }
    const stale = await invokeAntigravityHook({
      home, cwd,
      payload: { hookEventName: "SessionStart", conversationId: "stale-antigravity" },
    });

    assert.equal(stale.code, 1);
    assert.equal(stale.payload.reason, "SESSION_RUNTIME_STALE");
    const registry = createGlobalProjectRegistry({ home });
    try {
      assert.equal(registry.state.sessionObservations.get({
        provider: "antigravity",
        projectId: project.projectId,
        actorIdHash: actorHash("stale-antigravity"),
      }), null);
    } finally {
      registry.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity protected mutation binds the current observed work and generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-authorize-"));
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareProject({ root, home });
    const conversationId = "authorized-mutation";
    const toolCallId = "authorized-call";
    const { started } = await startAntigravityMutation({ home, cwd, conversationId, toolCallId });

    assert.equal(started.code, 0);
    assert.equal(started.payload.ok, true);
    assert.equal(started.payload.replayed, false);
    const registry = createGlobalProjectRegistry({ home });
    try {
      const operation = registry.state.operations.inspect(started.payload.operation.operationId);
      const observation = registry.state.sessionObservations.get({
        provider: "antigravity",
        projectId: project.projectId,
        actorIdHash: actorHash(conversationId),
      });
      assert.equal(operation.workId, observation.observedWorkId);
      assert.equal(operation.generation, observation.observedGeneration);
      assert.equal(observation.observedInstructionEpoch, 7);
    } finally {
      registry.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity protected mutations preserve stale work, generation, and epoch reasons", async (t) => {
  const cases = [
    ["work", "STALE_ACTIVE_WORK", { observedWorkId: "previous-work" }],
    ["generation", "STALE_GENERATION", { observedGeneration: 2 }],
    ["instruction epoch", "SESSION_RUNTIME_STALE", { observedInstructionEpoch: 6 }],
  ];
  for (const [name, reason, updates] of cases) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), `orchestra-antigravity-stale-${name.replaceAll(" ", "-")}-`));
      try {
        const home = join(root, "home");
        const { cwd, project } = await prepareProject({ root, home });
        const conversationId = `stale-${name}`;
        const attached = await invokeAntigravityHook({
          home, cwd,
          payload: { hookEventName: "SessionStart", conversationId },
        });
        assert.equal(attached.code, 0);
        const registry = createGlobalProjectRegistry({ home });
        try {
          if (name === "work") {
            assert.equal(registry.state.work.open(v2Work("previous-work", project.projectId)).ok, true);
          }
          assert.equal(mutateObservation(registry.state, { projectId: project.projectId, conversationId, ...updates }).ok, true);
        } finally {
          registry.close();
        }

        const denied = await invokeAntigravityHook({
          home, cwd,
          payload: {
            hookEventName: "PreToolUse",
            conversationId,
            toolCall: { id: `call-${name}`, name: "write_file" },
          },
        });
        assert.equal(denied.code, 1);
        assert.equal(denied.payload.reason, reason);
        assert.equal(denied.payload.hookSpecificOutput.permissionDecision, "deny");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("Antigravity host mutation requires factual tool-call correlation", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-correlation-required-"));
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareProject({ root, home });
    const conversationId = "missing-correlation";
    const attached = await invokeAntigravityHook({
      home, cwd,
      payload: { hookEventName: "SessionStart", conversationId },
    });
    assert.equal(attached.code, 0);
    const denied = await invokeAntigravityHook({
      home, cwd,
      payload: {
        hookEventName: "PreToolUse",
        conversationId,
        toolCall: { name: "write_file" },
      },
    });

    assert.equal(denied.code, 1);
    assert.equal(denied.payload.reason, "ANTIGRAVITY_TOOL_CORRELATION_REQUIRED");
    assert.equal(denied.payload.hookSpecificOutput.permissionDecision, "deny");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity host mutation uses provider-event ownership without process identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-provider-owner-"));
  try {
    const home = join(root, "home");
    const { cwd } = await prepareProject({ root, home });
    const { started } = await startAntigravityMutation({
      home, cwd, conversationId: "provider-owned", toolCallId: "provider-owned-call",
    });
    assert.equal(started.code, 0);

    const registry = createGlobalProjectRegistry({ home });
    const owners = createRuntimeOwnerStore({ rootDir: join(home, "runtime-owners") });
    try {
      const operation = registry.state.operations.inspect(started.payload.operation.operationId);
      const owner = await owners.read(operation.runtimeOwnerRef);
      assert.equal(owner.kind, "PROVIDER_EVENT");
      assert.equal(Object.hasOwn(owner, "process"), false);
      assert.equal(owner.correlationRef, hashId("provider-owned-call"));
    } finally {
      registry.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity duplicate terminal events converge idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-terminal-replay-"));
  try {
    const home = join(root, "home");
    const { cwd } = await prepareProject({ root, home });
    const conversationId = "terminal-replay";
    const toolCallId = "terminal-replay-call";
    const { started } = await startAntigravityMutation({ home, cwd, conversationId, toolCallId });
    assert.equal(started.code, 0);
    const terminalPayload = {
      hookEventName: "PostToolUse",
      conversationId,
      toolCall: { id: toolCallId, name: "write_file" },
      is_error: false,
    };
    const first = await invokeAntigravityHook({ home, cwd, payload: terminalPayload });
    const replay = await invokeAntigravityHook({ home, cwd, payload: terminalPayload });

    assert.equal(first.code, 0);
    assert.equal(first.payload.operation.workflowState, "SUCCEEDED");
    assert.equal(first.payload.replayed, false);
    assert.equal(replay.code, 0);
    assert.equal(replay.payload.operation.workflowState, "SUCCEEDED");
    assert.equal(replay.payload.replayed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity terminal correlation cannot cross provider, project, work, or actor", async (t) => {
  const cases = ["provider", "project", "work", "actor"];
  for (const mismatch of cases) {
    await t.test(mismatch, async () => {
      const root = await mkdtemp(join(tmpdir(), `orchestra-antigravity-mismatch-${mismatch}-`));
      try {
        const home = join(root, "home");
        const { cwd, project } = await prepareProject({ root, home });
        const conversationId = "mismatch-owner";
        const toolCallId = `mismatch-call-${mismatch}`;
        const { started } = await startAntigravityMutation({ home, cwd, conversationId, toolCallId });
        assert.equal(started.code, 0);
        const registry = createGlobalProjectRegistry({ home });
        try {
          const operationId = started.payload.operation.operationId;
          if (mismatch === "provider") {
            const codexOnlyToolCallId = `codex-only-${toolCallId}`;
            assert.equal(registry.state.operationCorrelations.put({
              provider: "codex",
              projectId: project.projectId,
              correlationHash: hashId(codexOnlyToolCallId),
              operationId,
              workId: "work-antigravity",
              generation: 3,
              actorIdHash: actorHash(conversationId),
            }).ok, true);
            assert.ok(registry.state.operationCorrelations.get({
              provider: "codex",
              projectId: project.projectId,
              correlationHash: hashId(codexOnlyToolCallId),
            }));
            assert.equal(registry.state.operationCorrelations.get({
              provider: "antigravity",
              projectId: project.projectId,
              correlationHash: hashId(codexOnlyToolCallId),
            }), null);
          } else if (mismatch === "work") {
            assert.equal(registry.state.work.open(v2Work("previous-work", project.projectId)).ok, true);
            assert.equal(mutateObservation(registry.state, {
              projectId: project.projectId,
              conversationId,
              observedWorkId: "previous-work",
            }).ok, true);
          }
        } finally {
          registry.close();
        }

        let terminalCwd = cwd;
        let terminalConversationId = conversationId;
        let terminalToolCallId = toolCallId;
        if (mismatch === "project") {
          const other = await prepareProject({
            root,
            home,
            workspaceName: "other-workspace",
            workId: "work-antigravity-other",
          });
          const attached = await invokeAntigravityHook({
            home, cwd: other.cwd,
            payload: { hookEventName: "SessionStart", conversationId },
          });
          assert.equal(attached.code, 0);
          terminalCwd = other.cwd;
        }
        if (mismatch === "actor") terminalConversationId = "different-actor";
        if (mismatch === "provider") terminalToolCallId = `codex-only-${toolCallId}`;
        const terminal = await invokeAntigravityHook({
          home,
          cwd: terminalCwd,
          payload: {
            hookEventName: "PostToolUse",
            conversationId: terminalConversationId,
            toolCall: { id: terminalToolCallId, name: "write_file" },
            is_error: false,
          },
        });
        assert.equal(terminal.code, 1);

        const verify = createGlobalProjectRegistry({ home });
        try {
          const operation = verify.state.operations.inspect(started.payload.operation.operationId);
          assert.equal(operation.workflowState, "RUNNING");
          assert.equal(operation.liveness, "LIVE");
        } finally {
          verify.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("lost Antigravity provider terminal event follows generic recoverable liveness", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-lost-terminal-"));
  try {
    const home = join(root, "home");
    const { cwd } = await prepareProject({ root, home });
    const { started } = await startAntigravityMutation({
      home, cwd, conversationId: "lost-terminal", toolCallId: "lost-terminal-call",
    });
    assert.equal(started.code, 0);
    const registry = createGlobalProjectRegistry({ home });
    const ownerStore = createRuntimeOwnerStore({ rootDir: join(home, "runtime-owners") });
    try {
      const operation = registry.state.operations.inspect(started.payload.operation.operationId);
      const observedAt = new Date(Date.parse(operation.deadlineAt) + 1_000).toISOString();
      const liveness = createOperationLivenessService({
        runtimeOwnerStore: ownerStore,
        providerEventProbe: createProviderEventProbe({ now: () => observedAt }),
        now: () => observedAt,
      });
      const assessment = await liveness.assess(operation);
      assert.equal(assessment.liveness, "STALE_RECOVERABLE");
      assert.equal(assessment.reason, "PROVIDER_EVENT_DEADLINE_EXPIRED_STALE");
    } finally {
      registry.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity public handler dispatches provider request event aliases", async (t) => {
  const requestAliases = [
    ["ToolCall", "ToolCall"],
    ["BeforeTool", "BeforeTool"],
    ["toolCall without event", null],
  ];
  for (const [name, eventName] of requestAliases) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), `orchestra-antigravity-request-alias-${name.replaceAll(" ", "-")}-`));
      try {
        const home = join(root, "home");
        const { cwd } = await prepareProject({ root, home });
        const conversationId = `request-${name}`;
        assert.equal((await invokeAntigravityHook({
          home, cwd,
          payload: { hookEventName: "SessionStart", conversationId },
        })).code, 0);
        const payload = {
          conversationId,
          ...(eventName ? { eventType: eventName } : {}),
          toolCall: { name: "read_file", args: { path: "src/main.mjs" } },
        };
        const request = await invokeAntigravityHook({ home, cwd, payload });
        assert.equal(request.code, 0);
        assert.equal(request.payload.ok, true);
        assert.equal(request.payload.hookSpecificOutput.permissionDecision, "allow");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("Antigravity public handler dispatches provider result event aliases", async (t) => {
  const resultAliases = ["ToolResult", "AfterTool"];
  for (const eventName of resultAliases) {
    await t.test(eventName, async () => {
      const root = await mkdtemp(join(tmpdir(), `orchestra-antigravity-result-alias-${eventName}-`));
      try {
        const home = join(root, "home");
        const { cwd } = await prepareProject({ root, home });
        const conversationId = `result-${eventName}`;
        const toolCallId = `call-${eventName}`;
        const { started } = await startAntigravityMutation({ home, cwd, conversationId, toolCallId });
        assert.equal(started.code, 0);
        const terminal = await invokeAntigravityHook({
          home, cwd,
          payload: {
            eventType: eventName,
            conversationId,
            toolCall: { id: toolCallId, name: "write_file" },
            is_error: false,
          },
        });
        assert.equal(terminal.code, 0);
        assert.equal(terminal.payload.operation.workflowState, "SUCCEEDED");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("Antigravity public handler rejects contradictory event aliases without authorizing", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-conflicting-events-"));
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareProject({ root, home });
    const conversationId = "conflicting-event-alias";
    assert.equal((await invokeAntigravityHook({
      home, cwd,
      payload: { hookEventName: "SessionStart", conversationId },
    })).code, 0);
    const denied = await invokeAntigravityHook({
      home, cwd,
      payload: {
        hookEventName: "AfterTool",
        eventType: "ToolCall",
        conversationId,
        toolCall: { id: "conflicting-event-call", name: "write_file" },
      },
    });

    assert.equal(denied.code, 1);
    assert.equal(denied.payload.reason, "ANTIGRAVITY_HOOK_EVENT_UNSUPPORTED");
    const registry = createGlobalProjectRegistry({ home });
    try {
      assert.equal(registry.state.operations.listLive({ projectId: project.projectId }).length, 0);
    } finally {
      registry.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity public handler fails closed on null payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-null-payload-"));
  try {
    const home = join(root, "home");
    await prepareProject({ root, home });
    const registry = createGlobalProjectRegistry({ home });
    try {
      const handler = createAntigravityHookHandler({ registry });
      assert.deepEqual(await handler.handle(null), {
        ok: false,
        reason: "ANTIGRAVITY_HOOK_PAYLOAD_INVALID",
      });
    } finally {
      registry.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity authority assesses coexisting factual local-process operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-local-owner-assessment-"));
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareProject({ root, home });
    const conversationId = "writer-blocked-by-process";
    assert.equal((await invokeAntigravityHook({
      home, cwd,
      payload: { hookEventName: "SessionStart", conversationId },
    })).code, 0);

    const readProcessIdentity = createHostProcessIdentityReader();
    const hostFact = await readProcessIdentity(process.pid);
    assert.equal(hostFact.status, "PRESENT");
    const now = new Date();
    const startedAt = now.toISOString();
    const operationId = "op-existing-local-process";
    const runtimeOwnerId = "runtime-owner-existing-local-process";
    const owner = {
      schema: "orchestra.runtime-owner.v2",
      runtimeOwnerId,
      operationId,
      kind: "LOCAL_PROCESS",
      registeredAt: startedAt,
      process: { pid: process.pid, startIdentity: hostFact.processIdentity },
      proof: { tokenHash: hashId("local-owner-proof") },
    };
    const registry = createGlobalProjectRegistry({ home });
    const ownerStore = createRuntimeOwnerStore({ rootDir: join(home, "runtime-owners") });
    try {
      assert.equal((await ownerStore.register(owner)).ok, true);
      const began = registry.state.operations.begin({
        expectedGeneration: 3,
        operation: {
          schema: "orchestra.operation.v2",
          operationId,
          projectId: project.projectId,
          workId: "work-antigravity",
          generation: 3,
          kind: "DIRECT_MUTATION",
          actorRef: hashId("another-owner"),
          capabilities: ["WORKSPACE_EDIT"],
          workflowState: "RUNNING",
          liveness: "LIVE",
          startedAt,
          heartbeatAt: startedAt,
          deadlineAt: new Date(now.valueOf() + 5 * 60_000).toISOString(),
          runtimeOwnerRef: runtimeOwnerId,
          workspaceRef: project.workspace.canonicalRoot,
          resultRef: null,
        },
      });
      assert.equal(began.ok, true);
    } finally {
      registry.close();
    }

    const denied = await invokeAntigravityHook({
      home, cwd,
      payload: {
        hookEventName: "PreToolUse",
        conversationId,
        toolCall: { id: "blocked-by-process", name: "write_file" },
      },
    });
    assert.equal(denied.code, 1);
    assert.equal(denied.payload.reason, "INCOMPATIBLE_LIVE_OPERATION");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});



test("Antigravity Orchestra process execution records factual local ownership through the executor seam", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-process-execution-"));
  let registry;
  let executionPromise;
  const releaseMarker = join(root, "release-child");
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareProject({ root, home });
    registry = createGlobalProjectRegistry({ home });
    const readProcessIdentity = createHostProcessIdentityReader();
    const now = () => new Date().toISOString();
    const actor = {
      schema: "orchestra.actor-provenance.v2",
      provider: "antigravity",
      subjectHash: actorHash("orchestra-owned-child"),
      source: "PROVIDER_FACT",
      observedAt: now(),
    };
    const report = { summary: "child completed", findings: [], evidenceRefs: [] };
    const processExecution = createAntigravityProcessExecution({
      registry,
      projectId: project.projectId,
      expectedWorkId: "work-antigravity",
      expectedGeneration: 3,
      observedInstructionEpoch: 7,
      actor,
      workspaceRef: project.workspace.canonicalRoot,
      readProcessIdentity,
      heartbeatIntervalMs: 20,
      spawnImpl: (_command, _args, options) => spawn(process.execPath, [
        "-e",
        `const fs = require("node:fs"); const marker = ${JSON.stringify(releaseMarker)}; const timer = setInterval(() => { if (fs.existsSync(marker)) { clearInterval(timer); process.stdout.write(${JSON.stringify(JSON.stringify(report))}); } }, 10)`,
      ], options),
    });
    const executor = createAntigravityDelegationExecutor({ runProcess: processExecution.runProcess });
    executionPromise = executor.execute({
      request: {
        target: { provider: "antigravity", logicalRole: "IMPLEMENTER" },
        limits: { timeoutMs: 15_000, maxOutputBytes: 4_096 },
      },
      workerEnvelope: { objective: "run the bounded AGY child" },
      workspace: { path: cwd },
    });

    const ownerStore = createRuntimeOwnerStore({ rootDir: join(home, "runtime-owners") });
    let operation;
    let owner;
    for (let attempt = 0; attempt < 1_000 && !owner; attempt += 1) {
      operation = registry.state.operations.listLive({ projectId: project.projectId })[0] ?? null;
      if (operation) owner = await ownerStore.read(operation.runtimeOwnerRef);
      if (!owner) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(operation, "spawned process must have a live global Operation");
    assert.equal(operation.kind, "DIRECT_MUTATION");
    assert.equal(operation.projectId, project.projectId);
    assert.equal(operation.workId, "work-antigravity");
    assert.equal(operation.generation, 3);
    assert.equal(operation.actorRef, actor.subjectHash);
    assert.equal(operation.workspaceRef, project.workspace.canonicalRoot);

    assert.equal(owner.kind, "LOCAL_PROCESS");
    assert.equal(owner.operationId, operation.operationId);
    assert.ok(owner.process.pid > 0);
    assert.equal(typeof owner.process.startIdentity, "string");
    assert.ok(owner.process.startIdentity.length > 0);
    assert.equal(Object.hasOwn(owner, "correlationRef"), false);

    const ownerProbe = createLocalProcessOwnerProbe({ readProcessIdentity, now });
    const liveness = createOperationLivenessService({ runtimeOwnerStore: ownerStore, ownerProbe, now });
    const assessment = await liveness.assess(operation);
    assert.equal(assessment.liveness, "LIVE");

    await new Promise((resolve) => setTimeout(resolve, 60));
    const heartbeated = registry.state.operations.inspect(operation.operationId);
    assert.ok(Date.parse(heartbeated.heartbeatAt) > Date.parse(operation.heartbeatAt));
    await mkdir(releaseMarker);
    const execution = await executionPromise;
    assert.equal(execution.ok, true);
    assert.deepEqual(execution.report, report);
    const terminal = registry.state.operations.inspect(operation.operationId);
    assert.equal(terminal.liveness, "TERMINAL");
    assert.equal(terminal.workflowState, "SUCCEEDED");
    assert.ok(Date.parse(terminal.deadlineAt) > Date.parse(terminal.startedAt));
  } finally {
    await mkdir(releaseMarker, { recursive: true }).catch(() => {});
    await executionPromise?.catch(() => {});
    registry?.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("Antigravity Orchestra process liveness cannot stay LIVE after PID birth identity mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-process-identity-mismatch-"));
  let registry;
  let executionPromise;
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareProject({ root, home });
    registry = createGlobalProjectRegistry({ home });
    let currentIdentity = { status: "PRESENT", processIdentity: "test:birth-1" };
    const readProcessIdentity = async () => currentIdentity;
    const actor = {
      schema: "orchestra.actor-provenance.v2",
      provider: "antigravity",
      subjectHash: actorHash("identity-mismatch-child"),
      source: "PROVIDER_FACT",
      observedAt: new Date().toISOString(),
    };
    const processExecution = createAntigravityProcessExecution({
      registry,
      projectId: project.projectId,
      expectedWorkId: "work-antigravity",
      expectedGeneration: 3,
      observedInstructionEpoch: 7,
      actor,
      workspaceRef: project.workspace.canonicalRoot,
      readProcessIdentity,
      heartbeatIntervalMs: 20,
      spawnImpl: (_command, _args, options) => spawn(process.execPath, [
        "-e",
        "setTimeout(() => process.stdout.write('done'), 500)",
      ], options),
    });
    executionPromise = processExecution.runProcess({
      command: "agy", args: [], cwd, timeoutMs: 2_000, maxOutputBytes: 1_024,
    });
    const ownerStore = createRuntimeOwnerStore({ rootDir: join(home, "runtime-owners") });
    let operation;
    let owner;
    for (let attempt = 0; attempt < 1_000 && !owner; attempt += 1) {
      operation = registry.state.operations.listLive({ projectId: project.projectId })[0] ?? null;
      if (operation) owner = await ownerStore.read(operation.runtimeOwnerRef);
      if (!owner) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(operation);
    assert.ok(owner);
    currentIdentity = { status: "PRESENT", processIdentity: "test:reused-pid-birth" };
    const ownerProbe = createLocalProcessOwnerProbe({ readProcessIdentity });
    const liveness = createOperationLivenessService({ runtimeOwnerStore: ownerStore, ownerProbe });
    const assessment = await liveness.assess(operation);
    assert.equal(assessment.liveness, "UNKNOWN");
    assert.equal(assessment.reason, "OWNER_MISMATCH_HEARTBEAT_FRESH");
    assert.equal(registry.state.operations.listLive({ projectId: project.projectId }).length, 1);
    currentIdentity = { status: "ABSENT" };
    const execution = await executionPromise;
    assert.equal(execution.exitCode, 0);
    assert.equal(registry.state.operations.inspect(operation.operationId).liveness, "TERMINAL");
  } finally {
    await executionPromise?.catch(() => {});
    registry?.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("Antigravity process execution fails closed when host start identity is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-process-no-identity-"));
  let registry;
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareProject({ root, home });
    registry = createGlobalProjectRegistry({ home });
    let child;
    let childClosed;
    const actor = {
      schema: "orchestra.actor-provenance.v2",
      provider: "antigravity",
      subjectHash: actorHash("no-child-identity"),
      source: "PROVIDER_FACT",
      observedAt: new Date().toISOString(),
    };
    const processExecution = createAntigravityProcessExecution({
      registry,
      projectId: project.projectId,
      expectedWorkId: "work-antigravity",
      expectedGeneration: 3,
      observedInstructionEpoch: 7,
      actor,
      workspaceRef: project.workspace.canonicalRoot,
      readProcessIdentity: async () => ({ status: "UNAVAILABLE" }),
      spawnImpl: (_command, _args, options) => {
        child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 500)"], options);
        childClosed = new Promise((resolve) => child.once("close", resolve));
        return child;
      },
    });
    await assert.rejects(processExecution.runProcess({
      command: "agy", args: [], cwd, timeoutMs: 2_000, maxOutputBytes: 1_024,
    }));
    assert.equal(registry.state.operations.listLive({ projectId: project.projectId }).length, 0);
    assert.ok(child);
    await childClosed;
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally {
    registry?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity process execution rejects a cwd outside its registered Project before spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-process-cross-project-"));
  let registry;
  try {
    const home = join(root, "home");
    const { project } = await prepareProject({ root, home, workspaceName: "project-a" });
    const otherCwd = await makeGitWorkspace(root, "project-b");
    registry = createGlobalProjectRegistry({ home });
    const other = await registry.registerWorkspace({
      root: otherCwd,
      runtimeImage: "2.0.0",
      instructionEpoch: 7,
      trustMode: "trusted",
    });
    assert.equal(other.ok, true);
    let spawnCount = 0;
    const actor = {
      schema: "orchestra.actor-provenance.v2",
      provider: "antigravity",
      subjectHash: actorHash("cross-project-process"),
      source: "PROVIDER_FACT",
      observedAt: new Date().toISOString(),
    };
    const processExecution = createAntigravityProcessExecution({
      registry,
      projectId: project.projectId,
      expectedWorkId: "work-antigravity",
      expectedGeneration: 3,
      observedInstructionEpoch: 7,
      actor,
      workspaceRef: project.workspace.canonicalRoot,
      readProcessIdentity: async () => ({ status: "PRESENT", processIdentity: "test:identity" }),
      spawnImpl: () => {
        spawnCount += 1;
        throw new Error("spawn must not run for another Project");
      },
    });
    await assert.rejects(processExecution.runProcess({
      command: "agy", args: [], cwd: otherCwd, timeoutMs: 1_000, maxOutputBytes: 1_024,
    }), (error) => /PROJECT|WORKSPACE/.test(error.code));
    assert.equal(spawnCount, 0);
  } finally {
    registry?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity process execution captures asynchronous spawn errors as structured failures", () => {
  const moduleUrl = new URL("../../v2/providers/antigravity/process-execution.mjs", import.meta.url).href;
  const script = `
    import { createAntigravityProcessExecution } from ${JSON.stringify(moduleUrl)};
    const root = process.cwd();
    const project = { schema: "orchestra.project.v2", projectId: "project-test", lineageId: "lineage-test", workspace: { canonicalRoot: root, vcs: "git" }, runtime: { pinnedImage: "2.0.0", instructionEpoch: 7 }, trust: { mode: "trusted" } };
    const work = { schema: "orchestra.work-unit.v2", workId: "work-test", projectId: project.projectId, taskId: "task-test", generation: 3, runtimeImage: "2.0.0", instructionEpoch: 7, state: "INTAKE", scopeRef: null, directionRef: null, candidateRef: null, evidenceRefs: [], blockers: [], continuationRef: null };
    const state = { projects: { inspect: () => project }, work: { current: () => work }, operations: { listLive: () => [], begin: () => ({ ok: true }), inspect: () => null, heartbeat: () => ({ ok: true }), terminalize: () => ({ ok: true }) } };
    const execution = createAntigravityProcessExecution({ registry: { paths: { home: root }, state, resolveWorkspace: async () => ({ projectId: project.projectId, workspace: project.workspace }) }, projectId: project.projectId, expectedWorkId: work.workId, expectedGeneration: work.generation, observedInstructionEpoch: 7, actor: { schema: "orchestra.actor-provenance.v2", provider: "antigravity", subjectHash: "sha256:${"a".repeat(64)}", source: "PROVIDER_FACT", observedAt: new Date().toISOString() }, workspaceRef: root });
    try { await execution.runProcess({ command: "orchestra-command-that-does-not-exist", args: [], cwd: root, timeoutMs: 1000, maxOutputBytes: 1024 }); process.exitCode = 10; }
    catch (error) { process.stdout.write(JSON.stringify({ code: error.code })); }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { code: "PROCESS_SPAWN_FAILED" });
});

test("Antigravity process authority assesses existing live local-process writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-process-live-owner-"));
  let registry;
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareProject({ root, home });
    registry = createGlobalProjectRegistry({ home });
    const readProcessIdentity = createHostProcessIdentityReader();
    const hostFact = await readProcessIdentity(process.pid);
    assert.equal(hostFact.status, "PRESENT");
    const startedAt = new Date().toISOString();
    const runtimeOwnerId = "runtime-owner-existing-process";
    const operationId = "op-existing-process";
    const ownerStore = createRuntimeOwnerStore({ rootDir: join(home, "runtime-owners") });
    assert.equal((await ownerStore.register({
      schema: "orchestra.runtime-owner.v2",
      runtimeOwnerId,
      operationId,
      kind: "LOCAL_PROCESS",
      registeredAt: startedAt,
      process: { pid: process.pid, startIdentity: hostFact.processIdentity },
      proof: { tokenHash: hashId("existing-process-owner-proof") },
    })).ok, true);
    assert.equal(registry.state.operations.begin({
      expectedGeneration: 3,
      operation: {
        schema: "orchestra.operation.v2",
        operationId,
        projectId: project.projectId,
        workId: "work-antigravity",
        generation: 3,
        kind: "DIRECT_MUTATION",
        actorRef: actorHash("existing-process-writer"),
        capabilities: ["WORKSPACE_EDIT"],
        workflowState: "RUNNING",
        liveness: "LIVE",
        startedAt,
        heartbeatAt: startedAt,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        runtimeOwnerRef: runtimeOwnerId,
        workspaceRef: project.workspace.canonicalRoot,
        resultRef: null,
      },
    }).ok, true);
    let spawnCount = 0;
    const actor = {
      schema: "orchestra.actor-provenance.v2",
      provider: "antigravity",
      subjectHash: actorHash("blocked-process-writer"),
      source: "PROVIDER_FACT",
      observedAt: new Date().toISOString(),
    };
    const processExecution = createAntigravityProcessExecution({
      registry,
      projectId: project.projectId,
      expectedWorkId: "work-antigravity",
      expectedGeneration: 3,
      observedInstructionEpoch: 7,
      actor,
      workspaceRef: project.workspace.canonicalRoot,
      readProcessIdentity,
      spawnImpl: () => {
        spawnCount += 1;
        throw new Error("live writer should deny before spawn");
      },
    });
    await assert.rejects(processExecution.runProcess({
      command: "agy", args: [], cwd, timeoutMs: 1_000, maxOutputBytes: 1_024,
    }), (error) => error.code === "INCOMPATIBLE_LIVE_OPERATION");
    assert.equal(spawnCount, 0);
  } finally {
    registry?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity process fencing rejects an Operation before the child payload can run", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-process-begin-fence-"));
  let registry;
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareProject({ root, home });
    registry = createGlobalProjectRegistry({ home });
    const deniedOperations = Object.freeze({
      ...registry.state.operations,
      begin: () => ({ ok: false, reason: "STALE_GENERATION" }),
    });
    const executionRegistry = {
      ...registry,
      state: { ...registry.state, operations: deniedOperations },
    };
    const payloadMarker = join(root, "child-payload-ran");
    const actor = {
      schema: "orchestra.actor-provenance.v2",
      provider: "antigravity",
      subjectHash: actorHash("fenced-child"),
      source: "PROVIDER_FACT",
      observedAt: new Date().toISOString(),
    };
    const processExecution = createAntigravityProcessExecution({
      registry: executionRegistry,
      projectId: project.projectId,
      expectedWorkId: "work-antigravity",
      expectedGeneration: 3,
      observedInstructionEpoch: 7,
      actor,
      workspaceRef: project.workspace.canonicalRoot,
      readProcessIdentity: async () => ({ status: "PRESENT", processIdentity: "test:identity" }),
      spawnImpl: (_command, _args, options) => spawn(process.execPath, [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(payloadMarker)}, "ran"); setTimeout(() => {}, 1000)`,
      ], options),
    });
    await assert.rejects(processExecution.runProcess({
      command: "agy", args: [], cwd, timeoutMs: 2_000, maxOutputBytes: 1_024,
    }), (error) => error.code === "STALE_GENERATION");
    assert.equal(existsSync(payloadMarker), false);
  } finally {
    registry?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity v2 shim artifacts call only the stable global launcher on POSIX and Windows", () => {
  const root = mkdtempSync(join(process.cwd(), ".orchestra antigravity shim's execution-"));
  try {
    const shimPath = join(root, "shim's path.mjs");
    writeFileSync(shimPath, "process.stdout.write('quoted path ran');\n");
    const posixShim = process.platform === "win32"
      ? execFileSync(join(dirname("C:\\Program Files\\Git\\bin\\bash.exe"), "..", "usr", "bin", "cygpath.exe"), ["-m", shimPath], { encoding: "utf8" }).trim()
      : shimPath;
    const posixNode = process.platform === "win32"
      ? execFileSync(join(dirname("C:\\Program Files\\Git\\bin\\bash.exe"), "..", "usr", "bin", "cygpath.exe"), ["-m", process.execPath], { encoding: "utf8" }).trim()
      : process.execPath;
    const posix = buildAntigravityV2ShimArtifacts({
      launcherPath: "/opt/Orchestra Tools/orchestra.mjs",
      nodePath: posixNode,
      shimPath: posixShim,
      platform: "linux",
    });
    const bashPath = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
    const posixRun = spawnSync(bashPath, ["-lc", posix.command], {
      encoding: "utf8",
      env: process.platform === "win32" ? { ...process.env, MSYS_NO_PATHCONV: "1" } : process.env,
    });
    assert.equal(posixRun.status, 0, posixRun.stderr);
    assert.equal(posixRun.stdout, "quoted path ran");

    const windows = buildAntigravityV2ShimArtifacts({
      launcherPath: "C:\\Program Files\\Orchestra\\orchestra.mjs",
      nodePath: process.execPath,
      shimPath,
    });
    assert.ok(windows.commandWindows.includes(`'${process.execPath.replaceAll("'", "''")}'`));
    assert.match(windows.commandWindows, /''/);
    assert.match(windows.hooksJson, /commandWindows/);
    if (process.platform === "win32") {
      const windowsRun = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", windows.commandWindows], {
        encoding: "utf8",
      });
      assert.equal(windowsRun.status, 0, windowsRun.stderr);
      assert.equal(windowsRun.stdout.trim(), "quoted path ran");
    }

    assert.ok(posix.command.includes("'\"'\"'"));
    assert.match(posix.shimSource, /Orchestra Tools/);
    assert.match(posix.shimSource, /provider.*antigravity.*hook/);
    assert.doesNotMatch(posix.shimSource, /WorkLease|Work Lease|Dream|recovery|policy|copied global core/i);
    assert.match(posix.shimSource, /from "node:child_process"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Antigravity v2 shim installs only registered-project transport files and forwards provider payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-v2-shim-install-"));
  let registry;
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareProject({ root, home });
    registry = createGlobalProjectRegistry({ home });
    const launcherDir = join(root, "global");
    await mkdir(launcherDir, { recursive: true });
    const launcherPath = join(launcherDir, "orchestra.mjs");
    await writeFile(launcherPath, `
      import { writeFileSync } from "node:fs";
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const input = Buffer.concat(chunks).toString();
      writeFileSync(${JSON.stringify(join(root, "forwarded.json"))}, input);
      if (process.argv.slice(2).join(" ") !== "provider antigravity hook") process.exit(9);
      process.stdout.write(JSON.stringify({
        ok: true,
        reason: null,
        forwarded: input,
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "fixture-context" },
      }));
    `);
    const installed = await installAntigravityV2Shim({
      registry,
      projectId: project.projectId,
      targetDir: cwd,
      launcherPath,
      nodePath: process.execPath,
    });

    assert.equal(installed.ok, true);
    assert.deepEqual([...installed.files].sort(), [".agents/hooks.json", ".agents/orchestra-v2-hook.mjs"]);
    const hooksPath = join(cwd, ".agents", "hooks.json");
    const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
    const userGroup = { SessionStart: [{ type: "command", command: "user-start", timeout: 5 }] };
    const userHandler = { type: "command", command: "project-start", timeout: 5 };
    hooks["user-hooks"] = userGroup;
    hooks["orchestra-v2-global"].SessionStart.unshift(userHandler);
    await writeFile(hooksPath, JSON.stringify(hooks));
    await installAntigravityV2Shim({
      registry,
      projectId: project.projectId,
      targetDir: cwd,
      launcherPath,
      nodePath: process.execPath,
    });
    const reinstalledHooks = JSON.parse(await readFile(hooksPath, "utf8"));
    assert.deepEqual(reinstalledHooks, hooks);
    assert.deepEqual(reinstalledHooks["user-hooks"], userGroup);
    assert.deepEqual(reinstalledHooks["orchestra-v2-global"].SessionStart[0], userHandler);
    assert.equal(reinstalledHooks["orchestra-v2-global"].SessionStart.length, 2);
    assert.equal(reinstalledHooks["orchestra-v2-global"].PreInvocation.length, 1);
    assert.equal(reinstalledHooks["orchestra-v2-global"].PreToolUse.length, 1);
    assert.equal(reinstalledHooks["orchestra-v2-global"].PostToolUse.length, 1);
    const legacyHooks = structuredClone(reinstalledHooks);
    const canonicalNode = await realpath(process.execPath);
    for (const eventName of ["SessionStart", "PreInvocation", "PreToolUse", "PostToolUse"]) {
      for (const entry of legacyHooks["orchestra-v2-global"][eventName]) {
        for (const handler of entry.hooks ?? [entry]) {
          if (handler.command?.includes("orchestra-v2-hook.mjs")) {
            handler.command = `'${canonicalNode.replaceAll("'", "'\"'\"'")}' '${join(project.workspace.canonicalRoot, ".agents", "orchestra-v2-hook.mjs").replaceAll("'", "'\"'\"'")}'`;
            handler.commandWindows = handler.commandWindows.replace(` --event ${eventName}`, "");
          }
        }
      }
    }
    await writeFile(hooksPath, JSON.stringify(legacyHooks));
    await installAntigravityV2Shim({ registry, projectId: project.projectId, targetDir: cwd, launcherPath, nodePath: process.execPath });
    assert.deepEqual(JSON.parse(await readFile(hooksPath, "utf8")), reinstalledHooks);
    assert.equal(existsSync(join(cwd, ".agents", "skills")), false);
    assert.equal(existsSync(join(cwd, ".agents", "state")), false);
    const shimPath = join(cwd, ".agents", "orchestra-v2-hook.mjs");
    const shim = await readFile(shimPath, "utf8");
    assert.match(shim, /provider.*antigravity.*hook/);
    assert.doesNotMatch(shim, /WorkLease|Work Lease|Dream|recovery|policy|copied global core/i);
    assert.match(shim, /from "node:child_process"/);

    const input = JSON.stringify({ eventType: "SessionStart", conversationId: "factual-session" });
    const forwarded = spawnSync(process.execPath, [shimPath], {
      cwd,
      input,
      encoding: "utf8",
    });
    assert.equal(forwarded.status, 0, forwarded.stderr);
    assert.deepEqual(JSON.parse(forwarded.stdout), { injectSteps: [] });
    assert.equal(await readFile(join(root, "forwarded.json"), "utf8"), input);
  } finally {
    registry?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity v2 shim canonicalizes equivalent registered roots and keeps project-local paths fenced", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-v2-shim-canonical-root-"));
  let registry;
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareProject({ root, home });
    const nestedDir = join(cwd, "nested");
    await mkdir(nestedDir, { recursive: true });
    registry = createGlobalProjectRegistry({ home });
    const launcherDir = join(root, "global");
    await mkdir(launcherDir, { recursive: true });
    const launcherPath = join(launcherDir, "orchestra.mjs");
    await writeFile(launcherPath, "process.exit(0);\n");
    const localLauncherPath = join(cwd, "local-launcher.mjs");
    const localNodePath = join(cwd, "local-node.mjs");
    await writeFile(localLauncherPath, "process.exit(0);\n");
    await writeFile(localNodePath, "process.exit(0);\n");
    const localLauncherAlias = `${cwd}${sep}.${sep}local-launcher.mjs`;
    const localNodeAlias = `${cwd}${sep}.${sep}local-node.mjs`;
    const equivalentRegistry = {
      paths: registry.paths,
      resolveWorkspace: async (workspaceRoot) => {
        const resolved = await registry.resolveWorkspace(workspaceRoot);
        return resolved && {
          ...resolved,
          workspace: { ...resolved.workspace, canonicalRoot: `${resolved.workspace.canonicalRoot}${sep}` },
        };
      },
    };

    const installed = await installAntigravityV2Shim({
      registry: equivalentRegistry,
      projectId: project.projectId,
      targetDir: cwd,
      launcherPath,
      nodePath: process.execPath,
    });
    assert.equal(installed.ok, true);

    await assert.rejects(installAntigravityV2Shim({
      registry,
      projectId: project.projectId,
      targetDir: nestedDir,
      launcherPath,
      nodePath: process.execPath,
    }), (error) => error.code === "ANTIGRAVITY_V2_PROJECT_NOT_REGISTERED");

    await assert.rejects(installAntigravityV2Shim({
      registry,
      projectId: project.projectId,
      targetDir: cwd,
      launcherPath: localLauncherAlias,
      nodePath: process.execPath,
    }), (error) => error.code === "ANTIGRAVITY_V2_GLOBAL_LAUNCHER_PROJECT_LOCAL");
    await assert.rejects(installAntigravityV2Shim({
      registry,
      projectId: project.projectId,
      targetDir: cwd,
      launcherPath,
      nodePath: localNodeAlias,
    }), (error) => error.code === "ANTIGRAVITY_V2_GLOBAL_LAUNCHER_PROJECT_LOCAL");
  } finally {
    registry?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("installed Antigravity v2 shim routes SessionStart, intake, read, mutation, and terminal events through the real global launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-v2-shim-e2e-"));
  let registry;
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareProject({ root, home });
    registry = createGlobalProjectRegistry({ home });
    const launcherPath = fileURLToPath(new URL("../../v2/global/orchestra.mjs", import.meta.url));
    const install = await installAntigravityV2Shim({
      registry,
      projectId: project.projectId,
      targetDir: cwd,
      launcherPath,
      nodePath: process.execPath,
    });
    assert.equal(install.ok, true);
    const shimPath = join(cwd, ".agents", "orchestra-v2-hook.mjs");
    const invoke = (payload) => {
      const result = spawnSync(process.execPath, [shimPath], {
        cwd,
        env: { ...process.env, ORCHESTRA_HOME: home },
        input: JSON.stringify(payload),
        encoding: "utf8",
      });
      assert.equal(result.status, 0, `shim failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      return JSON.parse(result.stdout);
    };

    const conversationId = "real-global-shim-conversation";
    const nativeInvocation = spawnSync(process.execPath, [shimPath, "--event", "PreInvocation"], {
      cwd, input: JSON.stringify({ conversationId, workspacePaths: [cwd], invocationNum: 0, initialNumSteps: 0 }), encoding: "utf8",
    });
    assert.equal(nativeInvocation.status, 0, nativeInvocation.stderr);
    assert.deepEqual(JSON.parse(nativeInvocation.stdout), { injectSteps: [] });
    assert.ok(registry.state.sessionObservations.get({ provider: "antigravity", projectId: project.projectId, actorIdHash: actorHash(conversationId) }));
    const attached = invoke({ hookEventName: "SessionStart", conversationId });
    assert.deepEqual(attached, { injectSteps: [] });
    const observation = registry.state.sessionObservations.get({ provider: "antigravity", projectId: project.projectId, actorIdHash: actorHash(conversationId) });
    assert.equal(observation.observedWorkId, "work-antigravity");
    assert.equal(observation.observedGeneration, 3);
    assert.equal(observation.observedInstructionEpoch, 7);

    const read = invoke({
      hookEventName: "PreToolUse",
      conversationId,
      toolCall: { id: "real-global-read", name: "read_file" },
    });
    assert.deepEqual(read, { decision: "allow" });

    const started = invoke({
      hookEventName: "PreToolUse",
      conversationId,
      toolCall: { id: "real-global-write", name: "write_file", args: { path: "src/main.mjs" } },
    });
    assert.deepEqual(started, { decision: "allow" });
    const operations = registry.state.operations.listLive({ projectId: project.projectId });
    assert.equal(operations.length, 1);
    const operationId = operations[0].operationId;
    assert.equal(operations[0].workflowState, "RUNNING");
    const terminal = invoke({
      hookEventName: "PostToolUse",
      conversationId,
      toolCall: { id: "real-global-write", name: "write_file" },
      is_error: false,
    });
    assert.deepEqual(terminal, {});
    assert.equal(registry.state.operations.inspect(operationId).workflowState, "SUCCEEDED");

    const intakeRoot = join(root, "intake-project-root");
    await mkdir(intakeRoot, { recursive: true });
    const { cwd: intakeCwd, project: intakeProject } = await prepareProject({
      root: intakeRoot,
      home,
      active: false,
      workspaceName: "intake-workspace",
    });
    const intakeInstall = await installAntigravityV2Shim({
      registry,
      projectId: intakeProject.projectId,
      targetDir: intakeCwd,
      launcherPath,
      nodePath: process.execPath,
    });
    assert.equal(intakeInstall.ok, true);
    const intake = spawnSync(process.execPath, [join(intakeCwd, ".agents", "orchestra-v2-hook.mjs")], {
      cwd: intakeCwd,
      env: { ...process.env, ORCHESTRA_HOME: home },
      input: JSON.stringify({ hookEventName: "SessionStart", conversationId: "real-global-intake" }),
      encoding: "utf8",
    });
    assert.equal(intake.status, 0, intake.stderr);
    const intakeResponse = JSON.parse(intake.stdout);
    assert.deepEqual(intakeResponse, { injectSteps: [] });
    const intakeObservation = registry.state.sessionObservations.get({ provider: "antigravity", projectId: intakeProject.projectId, actorIdHash: actorHash("real-global-intake") });
    assert.equal(intakeObservation.observedWorkId, null);
    assert.equal(intakeObservation.observedGeneration, null);
  } finally {
    registry?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity v2 shim validates response shape and fails closed actionably when global routing is invalid", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestra-antigravity-v2-shim-failure-"));
  let registry;
  try {
    const home = join(root, "home");
    const { cwd, project } = await prepareProject({ root, home });
    registry = createGlobalProjectRegistry({ home });
    const launcherPath = join(root, "global", "orchestra.mjs");
    await mkdir(join(root, "global"), { recursive: true });
    await writeFile(launcherPath, "process.stdout.write('{}');\n");
    await installAntigravityV2Shim({
      registry,
      projectId: project.projectId,
      targetDir: cwd,
      launcherPath,
      nodePath: process.execPath,
    });
    const shimPath = join(cwd, ".agents", "orchestra-v2-hook.mjs");
    const invalidResponses = [
      {
        payload: { hookEventName: "SessionStart", conversationId: "factual-session" },
        response: { ok: true },
      },
      {
        payload: { hook_event_name: "PreToolUse", conversationId: "factual-session" },
        response: { ok: true },
      },
      {
        payload: { hook_event_name: "PreToolUse", conversationId: "factual-session" },
        response: { ok: false, reason: "DENIED", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } },
      },
      {
        payload: { hook_event_name: "PreToolUse", conversationId: "factual-session" },
        response: { ok: true, reason: null, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } },
      },
      {
        payload: { hook_event_name: "PreToolUse", conversationId: "factual-session" },
        response: { ok: false, reason: "DENIED", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } },
        exitCode: 0,
      },
      {
        payload: { eventType: "ToolCall", conversationId: "factual-session", toolCall: { name: "write_file" } },
        response: "not-json",
      },
      {
        payload: { conversationId: "factual-session", toolCall: { name: "write_file" } },
        response: "not-json",
      },
    ];
    for (const { payload, response, exitCode = 0 } of invalidResponses) {
      const serialized = typeof response === "string" ? response : JSON.stringify(response);
      await writeFile(launcherPath, `process.stdout.write(${JSON.stringify(serialized)}); process.exitCode = ${exitCode};\n`);
      const result = spawnSync(process.execPath, [shimPath], {
        cwd,
        input: JSON.stringify(payload),
        encoding: "utf8",
      });
      const decoded = JSON.parse(result.stdout);
      if (["PreToolUse", "ToolCall"].includes(payload.hook_event_name || payload.eventType)
        || (payload.toolCall && !payload.eventType && !payload.hookEventName && !payload.hook_event_name)) {
        assert.equal(result.status, 0);
        assert.deepEqual(decoded, { decision: "deny", reason: "ORCHESTRA_V2_GLOBAL_UNAVAILABLE" });
      } else {
        assert.notEqual(result.status, 0);
        assert.deepEqual(decoded, { injectSteps: [] });
      }
      assert.match(result.stderr, /global Orchestra/i);
    }

    await rm(launcherPath);
    const missingLauncher = spawnSync(process.execPath, [shimPath], {
      cwd,
      input: JSON.stringify({ hook_event_name: "PreToolUse", conversationId: "factual-session" }),
      encoding: "utf8",
    });
    assert.equal(missingLauncher.status, 0);
    assert.equal(JSON.parse(missingLauncher.stdout).reason, "ORCHESTRA_V2_GLOBAL_UNAVAILABLE");
  } finally {
    registry?.close();
    await rm(root, { recursive: true, force: true });
  }
});
