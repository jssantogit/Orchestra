# Adaptive Resource Runtime (Issue #73)

The delegation boundary admits heavy work before discovery, clones, mutable
Operations or provider spawn. DIRECT_WORK selection is unchanged and does not
sample memory, train RSI, clone or add model calls. There is no idle timer,
daemon, supervisor model or PowerShell subprocess in admission.

## Capacity and provenance

`runtime/resources/platform-memory.mjs` reads physical/available memory and Node
constraints. Linux cgroup v2 ancestors contribute memory.max, memory.current and
memory.high; an unreadable/ambiguous hierarchy fails closed. Windows uses the
in-process Koffi binding to GetPerformanceInfo for **commit headroom**, separately
from physical RAM, and reads an enclosing Job's limit and conservative peak
usage. A pagefile does not increase the physical budget.

Unknown worker versions reserve 1536 MiB per worker plus an OS/user safety margin
of max(512 MiB, 20% of effective physical capacity). This is a conservative
fallback, not a claim that every native provider fits. Windows jobs additionally
enforce the reserved child-tree commit bound. No provider-peak learning is
claimed; measured peaks may inform a separately verified future estimator.

All Projects using one canonical Home share a bounded journal and exclusive
admission transaction. Only 64 reservations and 64 KiB of journal are accepted.
Atomic directory creation and same-directory rename serialize independent Node
controllers without a resident service or a SQLite dependency in V1. Different
Homes observe the same host headroom but do not have a global atomic reservation;
simultaneous admission across different Homes is not guaranteed.

## Backpressure and uncertainty

`withResourceAdmission` returns explicit DEFERRED/RESOURCE_BUDGET_UNAVAILABLE or
RESOURCE_UNVERIFIED before work. Cancellation and deadlines may reject a pending
attempt. There is no implicit queue, retry, route substitution or transition from
DELEGATED to DIRECT_WORK. A caller may later request a new admission; the native
entry point revalidates actor, Work, generation, epoch and the at-most-once fence.

Native, legacy and parallel brokers use the same boundary. Parallel groups reserve
the entire group before discovery/preparation; they defer atomically when it does
not fit, rather than starting two workers to discover capacity. The process runner
rechecks the inherited reservation before spawn, including the slot count.

On Windows a child is assigned to a memory-limited, non-breakaway Job before its
stdin/task is released. Job accounting includes inherited descendants, including
detached children. A surviving tree cannot produce successful output. The existing
argv-before-spawn-observer window still exists: assignment is not suspended
CreateProcess and is not a proof against arbitrary code that escapes before the
observer runs. This does not expand worker authority or relax recovery.

On POSIX the existing process-group observation preserves uncertainty. Group
absence is not full containment of escaped descendants. Only while a heavy child
is active, an unref'ed one-second check observes pressure without spawning a probe
process. Lost proof or pressure stops the owned tree and retains uncertainty.
Timeout, failed close
proof, surviving tree or UNKNOWN retains reservations and clones for human-gated
reconciliation. There is no automatic expiry or unsafe redispatch. A crashed
admission mutex fails closed; it is not silently reclaimed. Lightweight inspection,
Work status and cancellation do not require a new heavy admission. Low-level
`release(...terminalVerified:true)` is an internal caller obligation, not an
operator attestation or an instruction to modify the journal manually.

## RSI and acceptance

The durable native journal scans SQLite incrementally with bounded observations
(4096) and scanned rows (65536). Overflow refuses the campaign; it does not select
a favorable subset, change cohorts, thresholds, scopes or manufacture a candidate.
TRAIN/EVALUATE/HOLDOUT remain offline and source-provenance checked.

`node scripts/check-resource-runtime.mjs --windows-limit` creates an isolated
4-GiB Job for the check process. Linux CI runs the same tracked check inside an
actual 4-GiB cgroup with swap disabled. A controlled Node child is not native
Codex/AGY evidence. Under external host pressure it must defer, not bypass the
budget. Evidence records distinguish stable controller, controlled worker and
native provider availability. No claim of 4-GiB provider readiness follows from
unit tests, Job limits or green CI alone.

The initial Windows baseline at a976f76 measured controller RSS 40.8→47.4 MB,
direct-selection p95 0.000837 ms/call and import 3.77 ms. It was an 8-GiB physical
host under 96% commit pressure, **not** a 4-GiB field run. This microbenchmark is
not a full provider/no-Orchestra task comparison. Exact-head CI and a fresh
Runtime Image plus native field campaign are mandatory after software changes.

Sources: [Node process APIs](https://nodejs.org/download/release/v24.19.0/docs/api/process.html),
[Windows commit](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-getperformanceinfo),
[cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html),
[Koffi](https://koffi.dev/).
