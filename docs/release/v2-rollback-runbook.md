# Orchestra v2 Rollback Runbook

Status: operator-gated rollback procedure for V2-11 cutover incidents or rejected release candidates.

Rollback must restore a **supported explicit topology**. It must not silently recreate a per-Project v2 governance brain, rewrite user source, or erase evidence that explains what happened.

## Rollback targets

Use one of these supported targets only:

1. **Previous compatible v2 Runtime Image / integration state.** Restore the Project's prior verified v2 image pin and matching thin provider integration through the global control plane.
2. **Explicit v1 compatibility state.** When the migration/cutover contract requires it and the preserved v1 compatibility artifacts are still valid, restore that declared compatibility state through the approved migration rollback path.

Do not invent a hybrid state in which global v2 authority and a full project-local v2 authority runtime both claim control.

## Preconditions

Before changing state:

- record the exact current Project ID/lineage, Runtime Image ID, instruction epoch and Git head;
- run the **global status/recovery** path;
- resolve factual live/stale/dirty Operation state first;
- preserve the current readiness/field-evidence references;
- identify the exact supported rollback target and its evidence;
- obtain explicit operator approval for any rollback that changes a real Project's default operating topology.

If owner liveness is `UNKNOWN` or a workspace is dirty/ambiguous, fail closed. Preserve the workspace/artifact and use the official dirty-resolution path; do not clean it by editing files or state tables manually.

## Roll back to a previous v2 image

1. Quiesce the Project through the global Work/Operation boundary. No current Work or unresolved mutating Operation may remain.
2. Verify the previous Runtime Image is installed, content-addressed, integrity-valid and compatible with the current engine/provider adapters.
3. Run the global runtime rollback command with a unique command ID and the expected Project/runtime fence.
4. Confirm the Project pin returns to the expected previous v2 image and the instruction epoch advances.
5. Reinstall/verify only the approved thin provider shim if integration repair is required.
6. Start a fresh provider observation and verify stale pre-rollback observations are denied.
7. Verify the Project source tree is unchanged except for explicitly authorized provider integration files.
8. Run global status again and attach the sanitized rollback evidence references to the incident/release record.

Rollback of the runtime pin must never copy a full v2 governance runtime into the Project.

## Roll back to explicit v1 compatibility

Use this path only when the approved migration record declares a reversible v1 compatibility state.

1. Inspect the migration journal and preserved compatibility/private archives.
2. Verify the rollback target matches the Project lineage and the migration command being reversed.
3. Stop/resolve v2 Work and Operations through global authority.
4. Invoke the approved migration rollback/activation path; do not reconstruct v1 state from memory or model output.
5. Verify the provider integration now matches the declared v1 compatibility mode and that v2 does not continue claiming mutation authority for the Project.
6. Preserve migration evidence, runtime-image history, Experience references and provider field evidence for audit.
7. Run the v1 compatibility suite before resuming work.

V1 compatibility rollback is not permission to delete v2 global state or rewrite history.

## Artifact and evidence preservation

Preserved artifacts remain auditable throughout rollback. Keep:

- recovery/dirty workspaces that were preserved rather than safely cleaned;
- migration journals and classified legacy evidence;
- Runtime Image pin/epoch history;
- sanitized Experience/policy evidence;
- provider field-evidence references;
- exact CI/release run references.

Never commit raw prompts, transcripts, provider session IDs, private source, secrets, hidden reasoning, or arbitrary artifact bytes as rollback evidence.

## Post-rollback validation

Require all applicable checks for the selected topology:

- global Project status/recovery is quiescent or explicitly blocked with a factual reason;
- source tree fingerprint matches the pre-runtime-change state, apart from approved integration files;
- previous v2 image/integration or explicit v1 compatibility state is factual and internally consistent;
- provider sessions attach only through the authority mode belonging to that topology;
- stale runtime/session observations are denied;
- release/readiness records state that rollback occurred and do not claim cutover success.

## Operator boundary

Rollback itself does not authorize a release, merge, tag, publication, further migration, or v1 removal. After rollback, stop and present the preserved evidence to the operator. A later cutover attempt requires a new exact-head/readiness evaluation.
