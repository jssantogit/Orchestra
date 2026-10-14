import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runBoundedProcess } from "../../runtime/delegation/process-runner.mjs";

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "orchestra-process-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("bounded process captures success, stderr, duration, and merged environment", async () => {
  const result = await runBoundedProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.env.ORCHESTRA_TEST_VALUE); process.stderr.write('warn')"],
    cwd: process.cwd(),
    timeoutMs: 2000,
    maxOutputBytes: 1024,
    env: { ORCHESTRA_TEST_VALUE: "ok" },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "warn");
  assert.equal(result.stdoutTruncated, false);
  assert.equal(result.stderrTruncated, false);
  assert.equal(result.timedOut, false);
  assert.equal(Number.isInteger(result.durationMs), true);
  assert.equal(result.durationMs >= 0, true);
});

test("bounded process returns nonzero exit without converting it into transport failure", async () => {
  const result = await runBoundedProcess({
    command: process.execPath,
    args: ["-e", "process.stderr.write('nope'); process.exit(7)"],
    timeoutMs: 2000,
    maxOutputBytes: 1024,
  });

  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
  assert.equal(result.stderr, "nope");
});

test("bounded process writes exact stdin and closes it", async () => {
  const result = await runBoundedProcess({
    command: process.execPath,
    args: ["-e", "let v=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => v += c); process.stdin.on('end', () => process.stdout.write(v.toUpperCase()))"],
    input: "worker-envelope",
    timeoutMs: 2000,
    maxOutputBytes: 1024,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "WORKER-ENVELOPE");
});

test("stdout and stderr are independently byte-capped and flagged", async () => {
  const result = await runBoundedProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(4096)); process.stderr.write('y'.repeat(4096))"],
    timeoutMs: 2000,
    maxOutputBytes: 64,
  });

  assert.equal(Buffer.byteLength(result.stdout), 64);
  assert.equal(Buffer.byteLength(result.stderr), 64);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
  assert.equal(result.exitCode, 0);
});

test("timeout kills the child and it cannot later complete healthy work", async (t) => {
  const root = tempRoot(t);
  const heartbeat = join(root, "heartbeat.txt");
  const result = await runBoundedProcess({
    command: process.execPath,
    args: [
      "-e",
      "const fs=require('fs'); const p=process.argv[1]; setTimeout(() => fs.writeFileSync(p, 'alive'), 300); setInterval(() => {}, 1000)",
      heartbeat,
    ],
    timeoutMs: 50,
    maxOutputBytes: 1024,
  });

  assert.equal(result.timedOut, true);
  assert.notEqual(result.signal, null);
  assert.equal(result.exitCode, null);

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(existsSync(heartbeat), false, existsSync(heartbeat) ? readFileSync(heartbeat, "utf8") : "");
});

test("invalid limits and spawn failures fail closed", async () => {
  await assert.rejects(
    () => runBoundedProcess({ command: process.execPath, timeoutMs: 0, maxOutputBytes: 10 }),
    /PROCESS_LIMITS_INVALID/,
  );
  await assert.rejects(
    () => runBoundedProcess({ command: "orchestra-command-that-does-not-exist", timeoutMs: 100, maxOutputBytes: 10 }),
    (error) => error?.code === "PROCESS_SPAWN_FAILED",
  );
});
