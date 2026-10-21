# Native V2 Work execution integration

This continuation of PR #75 connects the production execution-policy selector
to the existing delegated executor. It does not authorize cutover or establish
native AGY/RSI field readiness. The frozen PR #75 evidence remains historical
for its exact HEAD and Runtime Image.

## Global entrypoint

`node runtime/delegation/v2-work-cli.mjs --home <isolated-Orchestra-Home>`
reads one bounded JSON envelope from stdin. The composition service is
`executeNativeWork(input, {registry})` in `runtime/delegation/v2-work-execution.mjs`.
It accepts these input fields only:

- `provider`: `codex` (default) or `antigravity`;
- `payload`: the actual provider `PreToolUse` event, including its factual
  actor/session identity, tool correlation, cwd and original tool input;
- `projectId`, `workId`, `generation`, `runtimeImageId`, `instructionEpoch`;
- optional `request`: the existing bounded `orchestra.delegation-request.v2`
  implementation packet for that Work, with cross-provider target, exact
  source fingerprint/revision and immutable mutation scope.

The native caller must route its actual event through this ingress **before**
executing the original tool. Do not synthesize a session/event or invoke an
ordinary PreToolUse hook first (which would already acquire the writer fence).
JSON input cannot select a route or supply an executor, policy, readiness or
authentication assertion. The controller validates the registered workspace
and persisted Session Observation against the exact Work tuple.

No packet means the ordinary direct provider authorization path: no discovery,
authentication probe, clone, extra LLM call or worker admission. Ordinary thin
provider hooks remain valid cheap direct ingress. For a delegable Work, its
controller uses the explicit Work entrypoint with the authorized packet;
hooks never invent a packet or globally choose to delegate arbitrary tools.

The initial integrated packet surface is a bounded native `apply_patch` event.
Every add/update/delete/move target must belong to the packet's mutation scope;
opaque shell commands and unsupported tool shapes fail closed. This ensures
both candidate routes refer to the same authorized bounded mutation.

## Selection and dispatch

The neutral composition root remains under `runtime/delegation`, the only
layer allowed to compose both external provider executors. V2 modules do not
import the runtime broker. There is no V1 broker, copied local governance
brain, automatic promotion or second delegated executor.

1. Verify actor provenance against the durable Session Observation, current
   Project/Work/generation/image/epoch, scope, source snapshot and writer fence.
2. For a valid packet only, obtain resource admission before provider discovery.
   Version/help discovery alone never establishes authentication. The target
   must complete a bounded, noninteractive, read-only native nonce response.
   No credential bytes are read or moved. Recheck authentication, capabilities,
   source identity and authority before recording a selection.
3. Derive immutable alternatives from those facts. A missing/unavailable/
   unauthenticated target leaves only DIRECT_WORK. Same-provider delegation is
   denied. The existing policy resolver reads genuinely activated Home policies;
   its static baseline remains DIRECT_WORK. Policies cannot widen alternatives.
4. Persist the selection before executing either route. It binds the actual
   Work tuple, actor, request digest, readiness reference, policy identities,
   immutable/legal choices and selected route. Caller JSON is never a selection
   capability. The stable delegation identity reserves this attempt across
   restarts, including a crash before opening an Operation.
5. DIRECT_WORK takes the existing provider authority/Operation/correlation path
   with the exact selection. Return `allow` to continue the original native tool.
   Its real PostToolUse must pass through the ordinary global provider hook to
   persist the terminal result. Missing decision receipts refuse the tool.
6. DELEGATED invokes `executeNativeDelegatedWork`, with the original deterministic
   Operation fence and isolated clone. It rechecks actual availability and
   authority around begin/dispatch. The original native tool is denied, including
   on delegated failure; a result is a sealed Home candidate, never a promoted
   edit or permission to redispatch. Child birth/close/group evidence, sandbox,
   scope, artifact integrity and cleanup requirements remain enforced.

Authentication probes are limited to explicit delegable Work admission. A
native probe may consume provider time; there are no such probes on the simple
direct tool path. A semantic refusal before worker dispatch does not classify
an already-closed discovery process as an uncertain worker. Uncertainty recorded
by the process runner/governor itself is preserved.

## Journal and learning boundary

The Home journal stores immutable `rsi_execution_selections` receipts. Each
native direct/delegated decision binds its selection digest. Replay reopens
the selection, Operation, Work, correlation/artifact and process proofs.
Selection tampering/missing provenance cannot yield a verified observation.

The legacy internal delegated bridge now records only **DELEGATED** unless an
integrated selection proves a genuine alternative. Historical bridge invocation
alone is no longer projected as proof that DIRECT_WORK was also available.

Injected executors are an internal software-test seam and are permanently
marked CONTROLLED_TEST in the selection. Their results are excluded from native
RSI projection, even after reopen and even when a controlled worker returns a
valid sealed artifact. CI proves software behavior, not provider authentication
or field learning. No caller-controlled `legalRoutes` is accepted by ingestion.

TRAIN/cohort/EVALUATE/HOLDOUT/replay criteria are unchanged. Direct-only native
observations still fail nontrivial-choice TRAIN. No manual route preference,
same-provider delegation, fabricated DELEGATED or manufactured candidate may be
used to bootstrap an ACTIVE policy. This integration consumes legitimately
activated policies through the existing resolver; it does not activate one.

## Candidate and field campaign

Freeze the new Git HEAD, build/verify its Runtime Image from clean Git, and run
the exact-head V2 Ubuntu/Windows, V1, POSIX and real 4-GiB governor CI gates.
All old HEAD-bound field evidence is historical.

On the new identity, run the six native Codex scenarios and affected canonical
probes again in isolated Projects/Home. For AGY, first provide an approved host
with legitimate native interactive authentication; do not transport credentials
or configure paid Gemini API. Native AGY needs its own six accepted scenarios.
For RSI, collect genuine integrated decisions/outcomes across at least four
independent registered lineages and fixed disjoint cohorts. Run the official
native TRAIN command, then canonical independent EVALUATE/HOLDOUT/replay. A
controlled policy fixture used to test delegated dispatch is not field data.

Native Windows collection remains separate from CI and Linux evidence. Real
Tsuzuki F7 migration still requires later operator authorization and actual
inventory/recovery evidence; disposable migration tests never close that gate.
Finally run canonical Git-bound collection/merge, provider evaluation, readiness
and release validation, retaining every missing/invalid/collector error. Stop
before merge, tag, release, publish, cutover or any real Tsuzuki modification.
