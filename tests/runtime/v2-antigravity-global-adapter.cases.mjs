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

async function prepareProject({ root, home, active = true }) {
  const cwd = await makeGitWorkspace(root);
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
        v2Work("work-antigravity", registered.project.projectId),
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
