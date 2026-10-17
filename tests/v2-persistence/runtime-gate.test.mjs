import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateV2RuntimeSupport,
  runGlobalLauncher,
} from "../../v2/global/orchestra.mjs";

function capture() {
  let value = "";
  return {
    stream: { write(chunk) { value += String(chunk); } },
    read() { return value; },
  };
}

test("v2 global launcher requires Node 24 or newer", () => {
  assert.deepEqual(evaluateV2RuntimeSupport("24.0.0"), {
    supported: true,
    currentVersion: "24.0.0",
    minimumMajor: 24,
  });
  assert.deepEqual(evaluateV2RuntimeSupport("23.11.1"), {
    supported: false,
    currentVersion: "23.11.1",
    minimumMajor: 24,
  });
  assert.deepEqual(evaluateV2RuntimeSupport("invalid"), {
    supported: false,
    currentVersion: "invalid",
    minimumMajor: 24,
  });
});

test("unsupported runtime fails structurally before loading sqlite-backed CLI", async () => {
  const stdout = capture();
  const stderr = capture();
  let loaded = false;

  const exitCode = await runGlobalLauncher({
    nodeVersion: "20.20.2",
    argv: ["home"],
    stdout: stdout.stream,
    stderr: stderr.stream,
    loadCli: async () => {
      loaded = true;
      throw new Error("must not load");
    },
  });

  assert.equal(exitCode, 2);
  assert.equal(loaded, false);
  assert.equal(stdout.read(), "");
  assert.deepEqual(JSON.parse(stderr.read()), {
    ok: false,
    code: "ORCHESTRA_V2_RUNTIME_UNSUPPORTED",
    message: "Orchestra v2 requires Node.js 24 or newer",
    currentNode: "20.20.2",
    minimumNodeMajor: 24,
  });
});

test("supported runtime delegates to the internal CLI with unchanged argv", async () => {
  const stdout = capture();
  const stderr = capture();
  const seen = [];

  const exitCode = await runGlobalLauncher({
    nodeVersion: "24.21.0",
    argv: ["home", "--home", "/tmp/orchestra"],
    stdout: stdout.stream,
    stderr: stderr.stream,
    loadCli: async () => ({
      runGlobalCli: async (options) => {
        seen.push(options.argv);
        return 7;
      },
    }),
  });

  assert.equal(exitCode, 7);
  assert.deepEqual(seen, [["home", "--home", "/tmp/orchestra"]]);
});
