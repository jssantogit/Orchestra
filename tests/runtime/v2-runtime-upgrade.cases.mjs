import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { runGlobalCli } from "../../v2/global/cli.mjs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function makeGitRepo(root) {
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  git("init", repo);
  return repo;
}

async function withSandbox(fn) {
  const root = await mkdtemp(join(tmpdir(), "orchestra-v2-runtime-upgrade-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sink() {
  let text = "";
  return {
    stream: { write(chunk) { text += chunk.toString(); } },
    text: () => text,
  };
}

async function cli({ home, cwd, args, input = null }) {
  const stdout = sink();
  const stderr = sink();
  const status = await runGlobalCli({
    argv: [...args, "--home", home],
    cwd,
    env: { ...process.env, ORCHESTRA_HOME: home },
    stdin: input === null ? Readable.from([]) : Readable.from([JSON.stringify(input)]),
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

async function writeSource(root, name, source) {
  const path = join(root, name);
  await writeFile(path, `${JSON.stringify(source)}\n`, "utf8");
  return path;
}

async function install(home, cwd, sourcePath) {
  const result = await cli({ home, cwd, args: ["runtime", "install", sourcePath] });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.json.ok, true);
  assert.match(result.json.image.imageId, /^sha256:[0-9a-f]{64}$/);
  return result.json.image;
}

async function register(home, repo, runtimeImage) {
  const result = await cli({
    home,
    cwd: repo,
    args: [
      "register", repo,
      "--runtime-image", runtimeImage,
      "--instruction-epoch", "0",
      "--trust", "trusted",
    ],
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.json.project;
}

async function hook(home, repo, provider, payload) {
  return cli({ home, cwd: repo, args: ["provider", provider, "hook"], input: { ...payload, cwd: repo } });
}

test("runtime list is read-only and non-initializing when Orchestra Home has no state", async () => {
  await withSandbox(async (root) => {
    const home = join(root, "home");
    const result = await cli({ home, cwd: root, args: ["runtime", "list"] });
    assert.equal(result.status, 0);
    assert.deepEqual(result.json, { ok: true, images: [] });
    await assert.rejects(access(home), { code: "ENOENT" });
  });
});

test("runtime install validates the source before recording and list is deterministic", async () => {
  await withSandbox(async (root) => {
    const home = join(root, "home");
    const bad = await writeSource(root, "bad.json", {
      ...runtimeSource("2.0.0", "bad"),
      files: [{ path: "runtime/instructions.txt", contentBase64: "@@not-base64@@" }],
    });
    const rejected = await cli({ home, cwd: root, args: ["runtime", "install", bad] });
    assert.equal(rejected.status, 2);
    assert.equal(rejected.errorJson.code, "ORCHESTRA_RUNTIME_IMAGE_SOURCE_INVALID");

    const firstSource = await writeSource(root, "a.json", runtimeSource("2.0.0", "image-a"));
    const secondSource = await writeSource(root, "b.json", runtimeSource("2.1.0", "image-b"));
    const first = await install(home, root, firstSource);
    const second = await install(home, root, secondSource);

    const listed = await cli({ home, cwd: root, args: ["runtime", "list"] });
    assert.equal(listed.status, 0);
    assert.deepEqual(
      listed.json.images.map((entry) => entry.imageId),
      [first.imageId, second.imageId].sort(),
    );
  });
});

test("upgrade and rollback require explicit command ids and expose pin plus resulting epoch", async () => {
  await withSandbox(async (root) => {
    const home = join(root, "home");
    const repo = await makeGitRepo(root);
    const imageA = await install(home, root, await writeSource(root, "a.json", runtimeSource("2.0.0", "image-a")));
    const imageB = await install(home, root, await writeSource(root, "b.json", runtimeSource("2.1.0", "image-b")));
    const project = await register(home, repo, imageA.imageId);

    const missingCommand = await cli({
      home,
      cwd: root,
      args: ["project", "upgrade", project.projectId, "--runtime-image", imageB.imageId],
    });
    assert.equal(missingCommand.status, 2);
    assert.equal(missingCommand.errorJson.code, "ORCHESTRA_V2_CLI_USAGE");

    const upgraded = await cli({
      home,
      cwd: root,
      args: [
        "project", "upgrade", project.projectId,
        "--runtime-image", imageB.imageId,
        "--command-id", "upgrade-1",
      ],
    });
    assert.equal(upgraded.status, 0, upgraded.stderr || upgraded.stdout);
    assert.equal(upgraded.json.ok, true);
    assert.equal(upgraded.json.oldPin, imageA.imageId);
    assert.equal(upgraded.json.newPin, imageB.imageId);
    assert.equal(upgraded.json.instructionEpoch, 1);

    const replay = await cli({
      home,
      cwd: root,
      args: [
        "project", "upgrade", project.projectId,
        "--runtime-image", imageB.imageId,
        "--command-id", "upgrade-1",
      ],
    });
    assert.equal(replay.status, 0);
    assert.equal(replay.json.replayed, true);
    assert.equal(replay.json.instructionEpoch, 1);

    const conflictingReuse = await cli({
      home,
      cwd: root,
      args: [
        "project", "rollback", project.projectId,
        "--runtime-image", imageA.imageId,
        "--command-id", "upgrade-1",
      ],
    });
    assert.equal(conflictingReuse.status, 1);
    assert.equal(conflictingReuse.json.reason, "IDEMPOTENCY_CONFLICT");
    const afterConflict = await cli({ home, cwd: root, args: ["project", "status", project.projectId] });
    assert.equal(afterConflict.status, 0);
    assert.equal(afterConflict.json.project.runtime.pinnedImage, imageB.imageId);
    assert.equal(afterConflict.json.project.runtime.instructionEpoch, 1);

    const rolledBack = await cli({
      home,
      cwd: root,
      args: [
        "project", "rollback", project.projectId,
        "--runtime-image", imageA.imageId,
        "--command-id", "rollback-1",
      ],
    });
    assert.equal(rolledBack.status, 0);
    assert.equal(rolledBack.json.oldPin, imageB.imageId);
    assert.equal(rolledBack.json.newPin, imageA.imageId);
    assert.equal(rolledBack.json.instructionEpoch, 2);
  });
});

test("unknown image or project fails without changing the existing project pin", async () => {
  await withSandbox(async (root) => {
    const home = join(root, "home");
    const repo = await makeGitRepo(root);
    const imageA = await install(home, root, await writeSource(root, "a.json", runtimeSource("2.0.0", "image-a")));
    const project = await register(home, repo, imageA.imageId);
    const missingImage = `sha256:${"f".repeat(64)}`;

    const imageFailure = await cli({
      home,
      cwd: root,
      args: [
        "project", "upgrade", project.projectId,
        "--runtime-image", missingImage,
        "--command-id", "missing-image",
      ],
    });
    assert.equal(imageFailure.status, 1);
    assert.equal(imageFailure.json.reason, "RUNTIME_IMAGE_NOT_INSTALLED");

    const projectFailure = await cli({
      home,
      cwd: root,
      args: [
        "project", "upgrade", "prj-missing",
        "--runtime-image", imageA.imageId,
        "--command-id", "missing-project",
      ],
    });
    assert.equal(projectFailure.status, 1);
    assert.equal(projectFailure.json.reason, "PROJECT_NOT_FOUND");

    const status = await cli({ home, cwd: root, args: ["project", "status", project.projectId] });
    assert.equal(status.status, 0);
    assert.equal(status.json.project.runtime.pinnedImage, imageA.imageId);
    assert.equal(status.json.project.runtime.instructionEpoch, 0);
  });
});

test("runtime epoch change makes old provider observations stale and next SessionStart sees the new epoch", async () => {
  await withSandbox(async (root) => {
    const home = join(root, "home");
    const repo = await makeGitRepo(root);
    const imageA = await install(home, root, await writeSource(root, "a.json", runtimeSource("2.0.0", "image-a")));
    const imageB = await install(home, root, await writeSource(root, "b.json", runtimeSource("2.1.0", "image-b")));
    const project = await register(home, repo, imageA.imageId);

    const codexStart = await hook(home, repo, "codex", { hook_event_name: "SessionStart", session_id: "codex-old" });
    assert.equal(codexStart.status, 0);
    const agyStart = await hook(home, repo, "antigravity", { hook_event_name: "SessionStart", conversationId: "agy-old" });
    assert.equal(agyStart.status, 0);

    const upgraded = await cli({
      home,
      cwd: root,
      args: [
        "project", "upgrade", project.projectId,
        "--runtime-image", imageB.imageId,
        "--command-id", "upgrade-epoch",
      ],
    });
    assert.equal(upgraded.status, 0);
    assert.equal(upgraded.json.instructionEpoch, 1);

    const staleCodex = await hook(home, repo, "codex", {
      hook_event_name: "PreToolUse",
      session_id: "codex-old",
      tool_call_id: "read-1",
      tool_name: "Read",
      tool_input: { file_path: "README.md" },
    });
    assert.equal(staleCodex.status, 1);
    assert.equal(staleCodex.json.reason, "SESSION_RUNTIME_STALE");
    assert.equal(staleCodex.json.currentInstructionEpoch, 1);

    const staleAgy = await hook(home, repo, "antigravity", {
      hook_event_name: "PreToolUse",
      conversationId: "agy-old",
      toolCall: { id: "read-2", name: "read_file", args: { path: "README.md" } },
    });
    assert.equal(staleAgy.status, 1);
    assert.equal(staleAgy.json.reason, "SESSION_RUNTIME_STALE");
    assert.equal(staleAgy.json.currentInstructionEpoch, 1);

    const freshCodex = await hook(home, repo, "codex", { hook_event_name: "SessionStart", session_id: "codex-new" });
    assert.equal(freshCodex.status, 0);
    assert.equal(JSON.parse(freshCodex.json.hookSpecificOutput.additionalContext).instructionEpoch, 1);

    const freshAgy = await hook(home, repo, "antigravity", { hook_event_name: "SessionStart", conversationId: "agy-new" });
    assert.equal(freshAgy.status, 0);
    assert.equal(JSON.parse(freshAgy.json.hookSpecificOutput.additionalContext).instructionEpoch, 1);
  });
});
