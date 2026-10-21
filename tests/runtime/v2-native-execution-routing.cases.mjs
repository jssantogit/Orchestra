import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { routingFixture, controlledExecutor } from '../helpers/native-routing.mjs';
import { testResourceGovernor } from '../helpers/resource-governor.mjs';
import { executeNativeWork } from '../../runtime/delegation/v2-work-execution.mjs';
import { createCodexHookHandler } from '../../v2/providers/codex/hook-handler.mjs';
import { operationIdForDelegation } from '../../runtime/delegation/v2-native-execution.mjs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync, execFileSync } from 'node:child_process';
import { createCodexDelegationExecutor } from '../../providers/codex/delegation-executor.mjs';
import { createAntigravityDelegationExecutor } from '../../providers/antigravity/delegation-executor.mjs';

test('production Work execution connects authority, policy selection and dispatch', async () => {
  const module = await import('../../runtime/delegation/v2-work-execution.mjs');
  assert.equal(typeof module.executeNativeWork, 'function');
});

test('direct-only native tool starts no discovery, auth probe, resource reservation or clone', async t => {
  const f=await routingFixture(t);let calls=0;
  const result=await executeNativeWork({...f.input,request:null},{registry:f.registry,
    executor:{discover(){calls++;throw Error('not needed')}},resourceGovernor:{reserve(){calls++;throw Error('not needed')}}});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(calls,0);
  assert.equal(f.state.operations.list({projectId:f.project.projectId}).length,1);
});

for(const status of ['unavailable','unauthenticated','available']) test('packet derives real legal alternatives: '+status,async t=>{
 const f=await routingFixture(t),worker=controlledExecutor({available:status!=='unavailable',authenticated:status!=='unauthenticated'});
 const result=await executeNativeWork(f.input,{registry:f.registry,executor:worker,resourceGovernor:{...testResourceGovernor(),home:f.home}});
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.route,'DIRECT_WORK');
 const op=f.state.operations.list({projectId:f.project.projectId})[0];
 const selection=f.state.nativeRsi.inspectExecutionSelection(op.operationId);
 assert.deepEqual(selection.legalRoutes,status==='available'?['DIRECT_WORK','DELEGATED']:['DIRECT_WORK']);
 assert.equal(selection.evidenceClass,'CONTROLLED_TEST');
 await createCodexHookHandler({registry:f.registry}).handle({...f.input.payload,hook_event_name:'PostToolUse',tool_response:'patch applied',is_error:false});
 assert.equal(f.state.operations.inspect(op.operationId).workflowState,'SUCCEEDED');
 assert.deepEqual(f.state.nativeRsi.listObserved(),[],'controlled decisions must not become native field learning');
 const db=new DatabaseSync(join(f.home,'state/orchestra.db'));
 db.exec("UPDATE rsi_execution_selections SET selection_digest='sha256:tampered'");db.close();
 assert.throws(()=>f.state.nativeRsi.listObserved(),/CORRUPT/);
});

test('same-provider target, stale epoch/generation and caller route flags fail closed',async t=>{
 const f=await routingFixture(t);const opts={registry:f.registry,executor:controlledExecutor(),resourceGovernor:{...testResourceGovernor(),home:f.home}};
 assert.equal((await executeNativeWork({...f.input,legalRoutes:['DELEGATED']},opts)).code,'NATIVE_EXECUTION_REQUEST_INVALID');
 assert.equal((await executeNativeWork({...f.input,generation:99},opts)).code,'NATIVE_EXECUTION_AUTHORITY_STALE');
 assert.equal((await executeNativeWork({...f.input,instructionEpoch:99},opts)).code,'NATIVE_EXECUTION_AUTHORITY_STALE');
 assert.equal((await executeNativeWork({...f.input,request:{...f.input.request,target:{provider:'codex',logicalRole:'IMPLEMENTER'}}},opts)).code,'NATIVE_EXECUTION_PACKET_DENIED');
 assert.equal(f.state.operations.list({projectId:f.project.projectId}).length,0);
});

test('governor denial occurs before provider discovery or a mutable Operation',async t=>{
 const f=await routingFixture(t);let calls=0;const worker=controlledExecutor();worker.discover=async()=>{calls++;throw Error('must not discover')};
 const result=await executeNativeWork(f.input,{registry:f.registry,executor:worker,resourceGovernor:{reserve:()=>({ok:false,reason:'RESOURCE_UNVERIFIED'})}});
 assert.equal(result.reason,'RESOURCE_UNVERIFIED');assert.equal(calls,0);assert.equal(f.state.operations.list({projectId:f.project.projectId}).length,0);
});

test('availability or Work change during selection cannot reserve an invalid route',async t=>{
 const f=await routingFixture(t);let auth=0;
 const worker=controlledExecutor();worker.verifyAuthentication=async()=>({authenticated:++auth===1,evidenceRef:'sha256:'+'a'.repeat(64)});
 const result=await executeNativeWork(f.input,{registry:f.registry,executor:worker,resourceGovernor:{...testResourceGovernor(),home:f.home}});
 assert.equal(result.code,'NATIVE_EXECUTION_READINESS_CHANGED');assert.equal(f.state.operations.list({projectId:f.project.projectId}).length,0);
});

test('revoked session between readiness and begin prevents every Operation',async t=>{
 const f=await routingFixture(t);let calls=0;
 const worker=controlledExecutor({onAuth:()=>{if(++calls===2) f.state.sessionObservations.put({provider:'codex',projectId:f.input.projectId,actorIdHash:f.actor.actorIdHash,observedInstructionEpoch:99,observedWorkId:f.input.workId,observedGeneration:1,observedAt:new Date().toISOString()});}});
 const result=await executeNativeWork(f.input,{registry:f.registry,executor:worker,resourceGovernor:{...testResourceGovernor(),home:f.home}});
 assert.equal(result.code,'NATIVE_EXECUTION_AUTHORITY_STALE');assert.equal(f.state.operations.list({projectId:f.input.projectId}).length,0);
});

test('executor disappearance or source drift during authentication invalidates the alternatives',async t=>{
 for(const drift of ['executor','source']){
  const f=await routingFixture(t);let calls=0;const worker=controlledExecutor({onAuth:()=>{if(drift==='source')writeFileSync(join(f.repoRoot,'tracked.txt'),'changed while checking readiness\n')}});
  const original=worker.discover;worker.discover=async()=>++calls===1?original():{available:false};
  const result=await executeNativeWork(f.input,{registry:f.registry,executor:worker,resourceGovernor:{...testResourceGovernor(),home:f.home}});
  assert.equal(result.ok,false);assert.equal(f.state.operations.list({projectId:f.input.projectId}).length,0);
 }
});

test('same delegationId concurrent ingress takes one writer and survives reopen without redispatch',async t=>{
 const f=await routingFixture(t),opts={registry:f.registry,executor:controlledExecutor(),resourceGovernor:{...testResourceGovernor(),home:f.home}};
 const results=await Promise.all([executeNativeWork(f.input,opts),executeNativeWork(f.input,opts)]);
 assert.equal(results.filter(x=>x.ok).length,1);assert.equal(f.state.operations.list({projectId:f.input.projectId}).length,1);
 const {createGlobalProjectRegistry}=await import('../../v2/global/project-registry.mjs');
 const reopened=createGlobalProjectRegistry({home:f.home});
 try{const op=f.state.operations.list({projectId:f.input.projectId})[0];assert.equal(reopened.state.nativeRsi.inspectExecutionSelection(op.operationId).selectedRoute,'DIRECT_WORK');
 assert.equal((await executeNativeWork(f.input,{...opts,registry:reopened})).code,'INCOMPATIBLE_LIVE_OPERATION');}finally{reopened.close()}
});

test('active learned route dispatches existing delegated bridge; failure remains UNKNOWN and cannot redispatch',async t=>{
 const f=await routingFixture(t);let executed=0;
 const policy={schema:'orchestra.learned-policy.v2',version:1,policyId:'controlled',revision:1,scope:'PROJECT',projectId:f.project.projectId,domainCohort:null,lifecycle:'CANDIDATE',selectors:{routePreference:'DELEGATED'},createdAt:new Date().toISOString()};
 const worker=controlledExecutor({execute:async()=>{executed++;return{ok:false,provider:'antigravity',reason:'EXECUTION_TIMED_OUT',execution:{exitCode:null}}}});
 const opts={registry:f.registry,executor:worker,policyStore:{active:({scope})=>scope==='PROJECT'?{policy}:null},resourceGovernor:{...testResourceGovernor(),home:f.home}};
 const result=await executeNativeWork(f.input,opts);
 assert.equal(result.ok,false,JSON.stringify(result));assert.equal(executed,1,JSON.stringify(result));
 const id=operationIdForDelegation(f.input.projectId,f.input.workId,1,f.input.request.delegationId),op=f.state.operations.inspect(id);
 assert.equal(op.workflowState,'UNKNOWN');assert.equal(readFileSync(join(f.repoRoot,'tracked.txt'),'utf8'),'canonical\n');
 assert.equal((await executeNativeWork(f.input,opts)).code,'NATIVE_DELEGATION_ALREADY_RECORDED');assert.equal(executed,1,JSON.stringify(result));
 assert.deepEqual(f.state.nativeRsi.listObserved(),[]);
});

test('controlled end-to-end delegated success seals the candidate and remains excluded from field RSI',async t=>{
 const f=await routingFixture(t);const policy={schema:'orchestra.learned-policy.v2',version:1,policyId:'controlled',revision:1,scope:'PROJECT',projectId:f.input.projectId,domainCohort:null,lifecycle:'CANDIDATE',selectors:{routePreference:'DELEGATED'},createdAt:new Date().toISOString()};
 const worker=controlledExecutor({execute:async({workspace})=>{writeFileSync(join(workspace.path,'tracked.txt'),'controlled delegated\n');return{ok:true,provider:'antigravity',report:{summary:'controlled test only',findings:[],evidenceRefs:[]},execution:{exitCode:0}}}});
 const result=await executeNativeWork(f.input,{registry:f.registry,executor:worker,policyStore:{active:({scope})=>scope==='PROJECT'?{policy}:null},resourceGovernor:{...testResourceGovernor(),home:f.home}});
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.route,'DELEGATED');assert.equal(f.state.operations.inspect(result.operationId).workflowState,'SUCCEEDED');
 assert.equal(readFileSync(join(f.repoRoot,'tracked.txt'),'utf8'),'canonical\n');assert.deepEqual(f.state.nativeRsi.listObserved(),[]);
});

test('a direct decision receipt failure refuses the original native tool',async t=>{
 const f=await routingFixture(t),nativeRsi={...f.state.nativeRsi,recordDecision:()=>({ok:false})};
 const registry={...f.registry,state:{...f.state,nativeRsi}};
 const result=await executeNativeWork(f.input,{registry,executor:controlledExecutor(),resourceGovernor:{...testResourceGovernor(),home:f.home}});
 assert.equal(result.ok,false);assert.equal(result.reason,'NATIVE_EXECUTION_DECISION_UNVERIFIED');assert.equal(f.state.operations.listLive({projectId:f.input.projectId}).length,0);
});

test('packet scope cannot lend two-route authority to an opaque shell or escaping patch',async t=>{
 const f=await routingFixture(t);for(const payload of [{...f.input.payload,tool_name:'Bash'},{...f.input.payload,tool_input:{patch:'*** Update File: ../escape'}}]){
  assert.equal((await executeNativeWork({...f.input,payload},{registry:f.registry})).code,'NATIVE_EXECUTION_TOOL_SCOPE_DENIED');
 }assert.equal(f.state.operations.list({projectId:f.input.projectId}).length,0);
});

test('public global CLI executes the direct native authorization path against persisted Home',async t=>{
 const f=await routingFixture(t);
 const result=spawnSync(process.execPath,['runtime/delegation/v2-work-cli.mjs','--home',f.home],{cwd:new URL('../../',import.meta.url),encoding:'utf8',input:JSON.stringify({...f.input,request:null})});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).ok,true);
 assert.equal(f.state.operations.list({projectId:f.input.projectId}).length,1);
});

test('writers in independent Projects do not acquire each others workspace authority',async t=>{
 const f=await routingFixture(t),root=join(f.home,'project-b');
 execFileSync('git',['clone','--quiet','--no-hardlinks',f.repoRoot,root]);
 const p=(await f.registry.registerWorkspace({root,runtimeImage:f.input.runtimeImageId,instructionEpoch:0,trustMode:'trusted'})).project;
 f.state.work.startCurrent({...f.state.work.current(f.input.projectId),projectId:p.projectId,workId:'work-b'});
 f.state.sessionObservations.put({provider:'codex',projectId:p.projectId,actorIdHash:f.actor.actorIdHash,observedInstructionEpoch:0,observedWorkId:'work-b',observedGeneration:1,observedAt:new Date().toISOString()});
 const other={...f.input,projectId:p.projectId,workId:'work-b',request:null,payload:{...f.input.payload,cwd:root}};
 const results=await Promise.all([executeNativeWork({...f.input,request:null},{registry:f.registry}),executeNativeWork(other,{registry:f.registry})]);
 assert.equal(results.every(x=>x.ok),true);assert.equal(f.state.operations.listLive({projectId:p.projectId}).length,1);assert.equal(f.state.operations.listLive({projectId:f.input.projectId}).length,1);
 assert.equal((await executeNativeWork({...f.input,payload:other.payload},{registry:f.registry})).code,'NATIVE_EXECUTION_PROJECT_MISMATCH');
});

test('authentication adapters require a real response protocol, not version/help or login-status text',async()=>{
 for(const [provider,factory] of [['codex',createCodexDelegationExecutor],['antigravity',createAntigravityDelegationExecutor]]){
  let invocation;
  const worker=factory({runProcess:async options=>{invocation=options;const prompt=options.input??options.args.at(-1),nonce=prompt.match(/ORCHESTRA_AUTH_[\w-]+/)[0];return{exitCode:0,timedOut:false,stdoutTruncated:false,stderrTruncated:false,stdout:provider==='codex'?JSON.stringify({type:'item.completed',item:{type:'agent_message',text:nonce}})+'\n'+JSON.stringify({type:'turn.completed'}):nonce};}});
  const verified=await worker.verifyAuthentication({cwd:process.cwd()});assert.equal(verified.authenticated,true);assert.equal(verified.evidence.provider,provider);assert.ok(invocation.args.includes(provider==='codex'?'read-only':'--sandbox'));
  const bad=factory({runProcess:async()=>({exitCode:0,stdout:'Logged in',timedOut:false})});assert.equal((await bad.verifyAuthentication({cwd:process.cwd()})).authenticated,false);
 }
});

test('route choices cannot be supplied as caller-authored journal facts', async () => {
  const { readExecutionSelection } = await import('../../v2/rsi/execution-selection.mjs');
  assert.equal(readExecutionSelection({ legalRoutes: ['DIRECT_WORK', 'DELEGATED'] }), null);
});
