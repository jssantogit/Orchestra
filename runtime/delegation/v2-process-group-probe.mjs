// Read-only observation of a POSIX detached process group. The native
// delegation runner uses detached:true on POSIX, so the initial child PID
// is also its group ID. A surviving group is grounds for preserving evidence,
// NOT proof of a particular descendant's identity (group IDs can be reused).
// Absence of this group cannot exclude descendants that called setsid,
// detached, or otherwise escaped it.
export function readDelegatedProcessGroupStatus(pid, {
  platform = process.platform, kill = process.kill.bind(process),
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647
    || platform === "win32" || typeof kill !== "function") return "UNAVAILABLE";
  try {
    kill(-pid, 0);
    return "PRESENT";
  } catch (error) {
    if (error?.code === "ESRCH") return "ABSENT";
    if (error?.code === "EPERM") return "PRESENT";
    return "UNAVAILABLE";
  }
}
