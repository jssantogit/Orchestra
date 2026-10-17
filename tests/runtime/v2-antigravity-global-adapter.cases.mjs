import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { createSqliteState } from "../../v2/persistence/sqlite/sqlite-state.mjs";
import { createGlobalProjectRegistry } from "../../v2/global/project-registry.mjs";
import { runGlobalCli } from "../../v2/global/cli.mjs";
import { createRuntimeOwnerStore } from "../../v2/liveness/runtime-owner-store.mjs";
import { createProviderEventProbe } from "../../v2/liveness/provider-event-liveness.mjs";
import { createOperationLivenessService } from "../../v2/liveness/operation-liveness-service.mjs";
import { createHostProcessIdentityReader } from "../../v2/liveness/local-process-probe.mjs";
import { createAntigravityHookHandler } from "../../v2/providers/antigravity/hook-handler.mjs";

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
