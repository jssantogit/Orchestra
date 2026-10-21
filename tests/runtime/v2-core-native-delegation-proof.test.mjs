import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCoreNativeDelegation } from '../../v2/cutover/core-native-delegation.mjs';
const IMG=`sha256:${'a'.repeat(64)}`;
const choice=`sha256:${'b'.repeat(64)}`;
const terminal=`sha256:${'c'.repeat(64)}`;
const auth=`sha256:${'d'.repeat(64)}`;
const operationId='op_delegated';
function validState(){
 const observation={schema:'orchestra.rsi-decision-outcome.v1',source:{operationId,lineageId:'l1'},decision:{selectedRoute:'DELEGATED',legalRoutes:['DIRECT_WORK','DELEGATED']},outcome:{success:true},evidence:{choiceRef:choice,outcomeRef:terminal}};
 const selection={operationId,projectId:'p1',workId:'w1',generation:1,runtimeImageId:IMG,sourceProvider:'codex',targetProvider:'antigravity',selectedRoute:'DELEGATED',legalRoutes:['DIRECT_WORK','DELEGATED'],evidenceClass:'NATIVE',readinessRef:auth};
 const operation={operationId,projectId:'p1',workId:'w1',generation:1,kind:'DELEGATED_MUTATION',workflowState:'SUCCEEDED',liveness:'TERMINAL',resultRef:`delegation-artifact:sha256:${'e'.repeat(64)}`};
 const nativeRsi={listObserved:()=>[observation],inspectExecutionSelection:()=>selection};
 return {nativeRsi,operations:{inspect:()=>operation},observation,selection,operation};
}
test('authentic native Codex-to-AGY Home observation projects sanitized refs',()=>{
 const {nativeRsi,operations}=validState();
 const result=inspectCoreNativeDelegation({state:{nativeRsi,operations},runtimeImageId:IMG});
 assert.equal(result.ok,true);
 assert.deepEqual(result.evidenceRefs,[choice,terminal,auth]);
 assert.equal(result.facts.sourceProvider,'codex');
 assert.equal(result.facts.targetProvider,'antigravity');
 assert.equal(result.facts.selectedRoute,'DELEGATED');
});
test('controlled, opposite provider, stale, uncertain and malformed proof fail closed',()=>{
 for(const change of [
  s=>{s.selection.evidenceClass='CONTROLLED_TEST'},
  s=>{s.selection.targetProvider='codex'},
  s=>{s.selection.sourceProvider='antigravity'},
  s=>{s.selection.runtimeImageId=`sha256:${'f'.repeat(64)}`},
  s=>{s.selection.operationId='unmatched'},
  s=>{s.operation.workflowState='UNKNOWN'},
  s=>{s.operation.kind='DIRECT_MUTATION'},
  s=>{s.observation.decision.selectedRoute='DIRECT_WORK'},
  s=>{s.observation.outcome.success=false},
  s=>{s.observation.evidence.outcomeRef='not-a-hash'},
 ]){const s=validState();change(s);
 const result=inspectCoreNativeDelegation({state:{nativeRsi:s.nativeRsi,operations:s.operations},runtimeImageId:IMG});
 assert.equal(result.ok,false,JSON.stringify(s));
 }
});
test('missing Home evidence never invents delegated success',()=>{
 const result=inspectCoreNativeDelegation({state:{nativeRsi:{listObserved:()=>[]}},runtimeImageId:IMG});
 assert.equal(result.ok,false);
 assert.deepEqual(result.evidenceRefs,[]);
});
