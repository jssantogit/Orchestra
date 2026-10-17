import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { runGlobalCli } from "../../v2/global/cli.mjs";
import { createGlobalProjectRegistry } from "../../v2/global/project-registry.mjs";
import { createRuntimeOwnerStore } from "../../v2/liveness/runtime-owner-store.mjs";
import { createRuntimeImageStore } from "../../v2/runtime-images/store.mjs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function withSandbox(fn) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-bootstrap-recovery-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function makeGitRepo(root) {
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  git("init", repo);
  return repo;
}

function sink() {
  let text = "";
  return {
    stream: { write(chunk) { text += chunk.toString(); } },
    text: () => text,
  };
}

async function cli({ home, cwd, args }) {
  const stdout = sink();
  const stderr = sink();
  const status = await runGlobalCli({
    argv: [...args, "--home", home],
    cwd,
    env: { ...process.env, ORCHESTRA_HOME: home },
    stdin: Readable.from([]),
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  const out = stdout.text().trim();
  const err = stderr.text().trim();
  return {
    status,
    json: out ? JSON.parse(out) : null,
    errorJson: err ? JSON.parse(err) : null,
    stdout: out,
    stderr: err,
  };
}

function runtimeSource(version, text) {
  return {
    schema: "orchestra.runtime-image-source.v2",
    version,
    engineCompatibility: { min: "2.0.0", max: "2.x" },
    providerAdapterCompatibility: {
      codex: { min: "2.0.0", max: "2.x" },
      antigravity: { min: "2.0.0", max: "2.x" },
    },
    files: [
      { path: "runtime/instructions.txt", contentBase64: Buffer.from(text, "utf8").toString("base64") },
    ],
  };
}

async function install(home, root, name, source) {
  const sourcePath = join(root, name);
  await writeFile(sourcePath, `${JSON.stringify(source)}\n`, "utf8");
  const result = await cli({ home, cwd: root, args: ["runtime", "install", sourcePath] });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.json.image;
}

test("global recovery stays executable above a corrupted pinned runtime and unlocks the next image", async () => {
  await withSandbox(async (root) => {
    const home = join(root, "home");
    const repo = await makeGitRepo(root);
    const imageN = await install(home, root, "n.json", runtimeSource("2.0.0", "broken-runtime-n"));
    const imageNext = await install(home, root, "n-plus-1.json", runtimeSource("2.1.0", "runtime-n-plus-1"));

    const registered = await cli({
      home,
      cwd: repo,
      args: [
        "register", repo,
        "--runtime-image", imageN.imageId,
        "--instruction-epoch", "0",
        "--trust", "trusted",
      ],
    });
    assert.equal(registered.status, 0, registered.stderr || registered.stdout);
    const project = registered.json.project;

    const startedAt = "2020-01-01T00:00:00.000Z";
    const deadlineAt = "2020-01-01T00:01:00.000Z";
    const operationId = "op_bootstrap_recovery";
    const runtimeOwnerId = `provider-owner:${operationId}`;
    const workId = "work_bootstrap_recovery";

    const registry = createGlobalProjectRegistry({ home });
    try {
      const work = {
        schema: "orchestra.work-unit.v2",
        workId,
        projectId: project.projectId,
        taskId: "task_bootstrap_recovery",
        generation: 0,
        runtimeImage: imageN.imageId,
        instructionEpoch: 0,
        state: "ACTIVE",
        scopeRef: null,
        directionRef: null,
        candidateRef: null,
        evidenceRefs: [],
        blockers: [],
        continuationRef: null,
      };
      const started = registry.state.work.startCurrent(work);
      assert.equal(started.ok, true, JSON.stringify(started));

      const operation = {
        schema: "orchestra.operation.v2",
        operationId,
        projectId: project.projectId,
        workId,
        generation: 0,
        kind: "DELEGATION",
        actorRef: "actor:bootstrap-recovery",
        capabilities: ["WORKSPACE_READ"],
        workflowState: "RUNNING",
        liveness: "LIVE",
        startedAt,
        heartbeatAt: startedAt,
        deadlineAt,
        runtimeOwnerRef: runtimeOwnerId,
        workspaceRef: null,
        resultRef: null,
      };
      const begun = registry.state.operations.begin({ expectedGeneration: 0, operation });
      assert.equal(begun.ok, true, JSON.stringify(begun));
    } finally {
      registry.close();
    }

    const ownerStore = createRuntimeOwnerStore({ rootDir: join(home, "runtime-owners") });
    const owner = await ownerStore.register({
      schema: "orchestra.runtime-owner.v2",
      runtimeOwnerId,
      operationId,
      kind: "PROVIDER_EVENT",
      registeredAt: startedAt,
      correlationRef: `sha256:${"a".repeat(64)}`,
      startedAt,
      lastProviderEventAt: startedAt,
      deadlineAt,
    });
    assert.equal(owner.ok, true, JSON.stringify(owner));

    const pinnedStore = createRuntimeImageStore({ orchestraHome: home });
    await pinnedStore.list();
    await writeFile(pinnedStore.locationFor(imageN.imageId), "corrupted pinned runtime manifest", "utf8");
    const broken = await pinnedStore.verify(imageN.imageId);
    assert.equal(broken.valid, false);

    const blocked = await cli({
      home,
      cwd: root,
      args: [
        "project", "upgrade", project.projectId,
        "--runtime-image", imageNext.imageId,
        "--command-id", "bootstrap-upgrade-before-recovery",
      ],
    });
    assert.equal(blocked.status, 1);
    assert.equal(blocked.json.reason, "PROJECT_RUNTIME_CHANGE_BLOCKED");

    const status = await cli({ home, cwd: root, args: ["project", "status", project.projectId] });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal(status.json.project.runtime.pinnedImage, imageN.imageId);
    assert.equal(status.json.reconciliation.operations.length, 1);
    assert.equal(status.json.reconciliation.operations[0].assessment.liveness, "STALE_RECOVERABLE");

    const recovered = await cli({
      home,
      cwd: root,
      args: [
        "project", "recover", project.projectId, operationId,
        "--command-id", "bootstrap-recover",
      ],
    });
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.equal(recovered.json.ok, true);
    assert.equal(recovered.json.recovered, true);

    const afterRecovery = createGlobalProjectRegistry({ home });
    try {
      const current = afterRecovery.state.work.current(project.projectId);
      assert.equal(current.workId, workId);
      const abandoned = afterRecovery.state.work.abandonCurrent({
        projectId: project.projectId,
        expectedWorkId: current.workId,
        expectedGeneration: current.generation,
        commandId: "bootstrap-abandon-work",
        reason: "runtime upgrade after stale-operation recovery",
      });
      assert.equal(abandoned.ok, true, JSON.stringify(abandoned));
    } finally {
      afterRecovery.close();
    }

    const upgraded = await cli({
      home,
      cwd: root,
      args: [
        "project", "upgrade", project.projectId,
        "--runtime-image", imageNext.imageId,
        "--command-id", "bootstrap-upgrade-after-recovery",
      ],
    });
    assert.equal(upgraded.status, 0, upgraded.stderr || upgraded.stdout);
    assert.equal(upgraded.json.oldPin, imageN.imageId);
    assert.equal(upgraded.json.newPin, imageNext.imageId);
    assert.equal(upgraded.json.instructionEpoch, 1);

    const finalStatus = await cli({ home, cwd: root, args: ["project", "status", project.projectId] });
    assert.equal(finalStatus.status, 0);
    assert.equal(finalStatus.json.project.runtime.pinnedImage, imageNext.imageId);
    assert.equal(finalStatus.json.reconciliation.work, null);
    assert.deepEqual(finalStatus.json.reconciliation.operations, []);
  });
});
