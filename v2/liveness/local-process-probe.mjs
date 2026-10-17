import { execFile as execFileCallback } from "node:child_process";
import { readFile as readFileDefault } from "node:fs/promises";
import { promisify } from "node:util";

import { validateOwnerObservationV2, validateRuntimeOwnerV2 } from "./contracts.mjs";

const execFileDefault = promisify(execFileCallback);

function unavailable() {
  return { status: "UNAVAILABLE" };
}

function absent() {
  return { status: "ABSENT" };
}

function present(processIdentity) {
  return { status: "PRESENT", processIdentity };
}

function normalizePid(pid) {
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function parseLinuxStartTicks(statText) {
  if (typeof statText !== "string") return null;
  const closeParen = statText.lastIndexOf(")");
  if (closeParen < 0) return null;
  const fieldsAfterComm = statText.slice(closeParen + 1).trim().split(/\s+/);
  // /proc/<pid>/stat field 3 starts at index 0 here; process starttime is field 22.
  const startTicks = fieldsAfterComm[19];
  return /^\d+$/.test(startTicks ?? "") ? startTicks : null;
}

function createLinuxReader({ readFileImpl }) {
  return async function readLinuxProcessIdentity(pid) {
    const normalized = normalizePid(pid);
    if (normalized === null) return unavailable();

    try {
      const [statText, bootIdText] = await Promise.all([
        readFileImpl(`/proc/${normalized}/stat`, "utf8"),
        readFileImpl("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const startTicks = parseLinuxStartTicks(statText);
      const bootId = String(bootIdText).trim();
      if (!startTicks || !bootId) return unavailable();
      return present(`linux:${bootId}:${startTicks}`);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") return absent();
      return unavailable();
    }
  };
}

function windowsProbeScript(pid) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "if ($null -eq $p) { Write-Output 'ABSENT'; exit 0 }",
    "$created = ([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()",
    "Write-Output ('PRESENT:' + $created)",
  ].join("; ");
}

function parseWindowsProbeOutput(result) {
  const stdout = typeof result === "string" ? result : result?.stdout;
  const output = String(stdout ?? "").trim();
  if (output === "ABSENT") return absent();
  const match = /^PRESENT:(-?\d+)$/.exec(output);
  if (!match) return unavailable();
  return present(`windows:${match[1]}`);
}

function createWindowsReader({ execFileImpl }) {
  const args = (pid) => [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    windowsProbeScript(pid),
  ];

  return async function readWindowsProcessIdentity(pid) {
    const normalized = normalizePid(pid);
    if (normalized === null) return unavailable();

    try {
      const result = await execFileImpl(
        "pwsh.exe",
        args(normalized),
        { encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 },
      );
      return parseWindowsProbeOutput(result);
    } catch (error) {
      if (error?.code !== "ENOENT") return unavailable();
    }

    try {
      const result = await execFileImpl(
        "powershell.exe",
        args(normalized),
        { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 },
      );
      return parseWindowsProbeOutput(result);
    } catch {
      return unavailable();
    }
  };
}

export function createHostProcessIdentityReader({
  platform = process.platform,
  readFileImpl = readFileDefault,
  execFileImpl = execFileDefault,
} = {}) {
  if (platform === "linux") return createLinuxReader({ readFileImpl });
  if (platform === "win32") return createWindowsReader({ execFileImpl });
  return async function unsupportedProcessIdentityReader() {
    return unavailable();
  };
}

export function createLocalProcessOwnerProbe({ readProcessIdentity, now = () => new Date().toISOString() } = {}) {
  if (typeof readProcessIdentity !== "function") throw new TypeError("readProcessIdentity is required");
  if (typeof now !== "function") throw new TypeError("now must be a function");

  return Object.freeze({
    async observe(runtimeOwner) {
      if (!validateRuntimeOwnerV2(runtimeOwner).valid || runtimeOwner.kind !== "LOCAL_PROCESS") {
        throw new TypeError("valid LOCAL_PROCESS runtime owner is required");
      }

      let hostFact;
      try {
        hostFact = await readProcessIdentity(runtimeOwner.process.pid);
      } catch {
        hostFact = unavailable();
      }

      let status = "UNAVAILABLE";
      let observedProcessIdentity = null;
      if (hostFact?.status === "ABSENT") {
        status = "ABSENT";
      } else if (hostFact?.status === "PRESENT" && typeof hostFact.processIdentity === "string" && hostFact.processIdentity.length > 0) {
        observedProcessIdentity = hostFact.processIdentity;
        status = hostFact.processIdentity === runtimeOwner.process.startIdentity ? "MATCH" : "MISMATCH";
      }

      const observation = {
        schema: "orchestra.owner-observation.v2",
        runtimeOwnerId: runtimeOwner.runtimeOwnerId,
        observedAt: now(),
        status,
        observedProcessIdentity,
      };
      if (!validateOwnerObservationV2(observation).valid) {
        throw new TypeError("owner probe produced an invalid observation");
      }
      return observation;
    },
  });
}
