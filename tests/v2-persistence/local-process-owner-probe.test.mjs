import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import {
  createHostProcessIdentityReader,
  createLocalProcessOwnerProbe,
} from "../../v2/liveness/local-process-probe.mjs";

const OBSERVED_AT = "2026-10-17T02:20:00.000Z";

function owner(overrides = {}) {
  return {
    schema: "orchestra.runtime-owner.v2",
    runtimeOwnerId: "owner:probe",
    operationId: "op-probe",
    kind: "LOCAL_PROCESS",
    process: { pid: 4242, startIdentity: "host-start:expected" },
    proof: { tokenHash: `sha256:${"d".repeat(64)}` },
    registeredAt: "2026-10-17T02:19:00.000Z",
    ...overrides,
  };
}

function fakeProbe(result) {
  return createLocalProcessOwnerProbe({
    readProcessIdentity: async () => result,
    now: () => OBSERVED_AT,
  });
}

test("local process probe maps matching birth identity to MATCH", async () => {
  const probe = fakeProbe({ status: "PRESENT", processIdentity: "host-start:expected" });
  const result = await probe.observe(owner());

  assert.deepEqual(result, {
    schema: "orchestra.owner-observation.v2",
    runtimeOwnerId: "owner:probe",
    observedAt: OBSERVED_AT,
    status: "MATCH",
    observedProcessIdentity: "host-start:expected",
  });
});

test("PID reuse maps a present but different birth identity to MISMATCH", async () => {
  const probe = fakeProbe({ status: "PRESENT", processIdentity: "host-start:replacement" });
  const result = await probe.observe(owner());

  assert.equal(result.status, "MISMATCH");
  assert.equal(result.observedProcessIdentity, "host-start:replacement");
});

test("absent and unavailable host facts stay distinct", async () => {
  const absent = await fakeProbe({ status: "ABSENT" }).observe(owner());
  const unavailable = await fakeProbe({ status: "UNAVAILABLE" }).observe(owner());

  assert.equal(absent.status, "ABSENT");
  assert.equal(absent.observedProcessIdentity, null);
  assert.equal(unavailable.status, "UNAVAILABLE");
  assert.equal(unavailable.observedProcessIdentity, null);
});

test("host identity reader factually identifies the current process on supported CI hosts", async (t) => {
  if (!new Set(["linux", "win32"]).has(process.platform)) {
    t.skip(`host probe fixture not defined for ${process.platform}`);
    return;
  }

  const readIdentity = createHostProcessIdentityReader();
  const current = await readIdentity(process.pid);

  assert.equal(current.status, "PRESENT");
  assert.equal(typeof current.processIdentity, "string");
  assert.notEqual(current.processIdentity.length, 0);

  const probe = createLocalProcessOwnerProbe({
    readProcessIdentity: readIdentity,
    now: () => OBSERVED_AT,
  });
  const observation = await probe.observe(owner({
    process: { pid: process.pid, startIdentity: current.processIdentity },
  }));
  assert.equal(observation.status, "MATCH");
});

test("a terminated child can never still MATCH its original owner identity", async (t) => {
  if (!new Set(["linux", "win32"]).has(process.platform)) {
    t.skip(`host probe fixture not defined for ${process.platform}`);
    return;
  }

  const readIdentity = createHostProcessIdentityReader();
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const pid = child.pid;
  assert.equal(Number.isInteger(pid), true);

  try {
    const initial = await readIdentity(pid);
    assert.equal(initial.status, "PRESENT");

    const probe = createLocalProcessOwnerProbe({
      readProcessIdentity: readIdentity,
      now: () => OBSERVED_AT,
    });
    child.kill();
    await once(child, "exit");

    const after = await probe.observe(owner({
      process: { pid, startIdentity: initial.processIdentity },
    }));
    assert.ok(["ABSENT", "MISMATCH"].includes(after.status));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

test("unsupported host platform returns UNAVAILABLE instead of guessing", async () => {
  const readIdentity = createHostProcessIdentityReader({ platform: "unsupported-os" });
  assert.deepEqual(await readIdentity(123), { status: "UNAVAILABLE" });
});
