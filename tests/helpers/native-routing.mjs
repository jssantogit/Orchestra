import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createGlobalProjectRegistry } from '../../v2/global/project-registry.mjs';
import { readWorkspaceFingerprint } from '../../core/leases/workspace-fingerprint.mjs';
export const sessionId='controlled-software-test-session';
const ACTOR='sha256:'+createHash('sha256').update(sessionId).digest('hex');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:'pipe'}).trim();
export async function routingFixture(t){
 const home=mkdtempSync(join(tmpdir(),'orchestra-routing-')),repoRoot=join(home,'repository');mkdirSync(repoRoot);
 git(repoRoot,'init');git(repoRoot,'config','user.email','test@example.invalid');git(repoRoot,'config','user.name','Routing Test');
 writeFileSync(join(repoRoot,'tracked.txt'),'canonical\n');git(repoRoot,'add','.');git(repoRoot,'commit','-m','fixture');
 const registry=createGlobalProjectRegistry({home}),state=registry.state;
 t.after(()=>{registry.close();rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:120});});
 const project=(await registry.registerWorkspace({root:repoRoot,runtimeImage:'sha256:exact-image',instructionEpoch:0,trustMode:'trusted'})).project;
 const projectId=project.projectId,workId='work-native',generation=1;
 state.work.startCurrent({schema:'orchestra.work-unit.v2',projectId,workId,taskId:'task-native',generation,runtimeImage:project.runtime.pinnedImage,instructionEpoch:0,state:'INTAKE',scopeRef:null,directionRef:null,candidateRef:null,evidenceRefs:[],blockers:[],continuationRef:null});
 state.sessionObservations.put({provider:'codex',projectId,actorIdHash:ACTOR,observedInstructionEpoch:0,observedWorkId:workId,observedGeneration:generation,observedAt:new Date().toISOString()});
  const source = readWorkspaceFingerprint(repoRoot, { excludedPaths: [".orchestra/state/**"] });
  const request = {
    schema: "orchestra.delegation-request.v2", delegationId: "v2-delegation-native",
    taskId: "task-native",
    source: { provider: "codex", actorIdHash: ACTOR },
    target: { provider: "antigravity", logicalRole: "IMPLEMENTER" },
    purpose: "IMPLEMENTATION",
    packet: {
      schema: "orchestra.implementation-packet.v1", taskId: "task-native",
      candidateGeneration: generation,
      goal: "edit tracked.txt within an isolated delegated workspace",
      direction: { change: "edit tracked.txt", preserve: ["canonical checkout"] },
      anchors: [{ file: "tracked.txt" }],
      scope: { allowedAreas: ["tracked.txt"], forbidden: [".orchestra/state/**"] },
      permissions: { discovery: "DIRECTED", tests: "MODIFY_AUTHORIZED_TARGETS",
        sideEffects: ["WORKSPACE_EDIT", "LOCAL_TEST"] },
      validation: ["tracked.txt updated"],
      failurePolicy: { selfCaused: "REPAIR", unrelatedOrUncertain: "RETURN_TO_CONTROL" },
    },
    authority: { capabilities: ["LOCAL_READ", "PROCESS_EXEC", "WORKSPACE_EDIT"],
      mutation: "WORKSPACE_ONLY", network: "FORBIDDEN", mayDelegate: false },
    workspace: {
      sourceFingerprint: source.fingerprint, sourceRevision: source.head,
      isolation: "EPHEMERAL_CLONE",
      mutationScope: { allowedPaths: ["tracked.txt"], forbiddenPaths: [] },
    },
    limits: { timeoutMs: 30_000, maxOutputBytes: 65536, delegationDepth: 1 },
  };
 const input={projectId,workId,generation,runtimeImageId:project.runtime.pinnedImage,instructionEpoch:0,request,payload:{hook_event_name:'PreToolUse',session_id:sessionId,cwd:repoRoot,tool_name:'apply_patch',tool_use_id:'controlled-tool-call',tool_input:{patch:'*** Begin Patch\n*** Update File: tracked.txt\n@@\n-canonical\n+changed\n*** End Patch'}}};
 return {home,repoRoot,registry,state,project,input,actor:{provider:'codex',actorIdHash:ACTOR}};
}
export function controlledExecutor({authenticated=true,available=true,onAuth=()=>{},execute=async()=>({ok:false,provider:'antigravity',reason:'CONTROLLED_FAILURE'})}={}){
 return {provider:'antigravity',async discover(){return{available,provider:'antigravity',version:'controlled-test-only',capabilities:{implementation:true}}},async verifyAuthentication(){await onAuth();return{authenticated,evidenceRef:'sha256:'+'a'.repeat(64)}},execute};
}
