import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateV2ReadinessProfile } from '../../v2/cutover/readiness-profiles.mjs';

const HEAD = 'a'.repeat(40);
const IMAGE = `sha256:${'b'.repeat(64)}`;
const HOME = `sha256:${'c'.repeat(64)}`;
const receipt = (facts = {}) => ({ status:'VERIFIED', headSha:HEAD, facts });
function evidence() {
  return {
    registryPersistence:receipt(), providers:{codex:receipt(),antigravity:receipt()},
    runtimeLifecycle:receipt({installed:true,pinned:true,rollbackVerified:true,runtimeImageId:IMAGE}),
    reconciliation:receipt({staleRecoveryVerified:true,dirtyRecoveryVerified:true}),
    experiencePrivacy:receipt(),
    migration:receipt({migrationVerified:true,tsuzukiF7Verified:false}),
    platforms:{windows:receipt(),posix:receipt()},
    projects:[
      receipt({projectId:'p1',lineageId:'l1',homeIdentity:HOME,noFullLocalGovernanceRuntime:true}),
      receipt({projectId:'p2',lineageId:'l2',homeIdentity:HOME,noFullLocalGovernanceRuntime:true}),
    ],
    selfHost:receipt({projectId:'self',lineageId:'selfline',runtimeImageId:IMAGE,homeIdentity:HOME,noFullLocalGovernanceRuntime:true}),
  };
}
function nativeDelegation() {
  return {
    schema:'orchestra.core-native-delegation-evidence.v1',version:1,
    status:'VERIFIED',headSha:HEAD,runtimeImageId:IMAGE,
    sourceProvider:'codex',targetProvider:'antigravity',evidenceClass:'NATIVE',
    selectedRoute:'DELEGATED',operationKind:'DELEGATED_MUTATION',workflowState:'SUCCEEDED',
    facts:{workAuthorityVerified:true,terminalVerified:true,artifactVerified:true,processProvenanceVerified:true,selectionVerified:true},
    evidenceRefs:[`sha256:${'d'.repeat(64)}`],
  };
}

test('Adaptive keeps the original RSI and factual Tsuzuki F7 requirements', () => {
  const result=evaluateV2ReadinessProfile({profile:'ADAPTIVE',expectedHeadSha:HEAD,expectedRuntimeImageId:IMAGE,evidence:evidence(),nativeDelegation:nativeDelegation()});
  assert.equal(result.ready,false);
  assert.equal(result.code,'CUTOVER_NOT_READY');
  assert.ok(result.missing.includes('rsiReplay'));
  assert.ok(result.invalid.includes('migration:tsuzukiF7Verified'));
});

test('Core defers only adaptive learning and Tsuzuki-specific F7, retaining generic migration', () => {
  const result=evaluateV2ReadinessProfile({profile:'CORE',expectedHeadSha:HEAD,expectedRuntimeImageId:IMAGE,evidence:evidence(),nativeDelegation:nativeDelegation()});
  assert.equal(result.ready,true);
  assert.equal(result.code,'V2_CORE_READY');
  assert.deepEqual(result.missing,[]);
  assert.deepEqual(result.invalid,[]);
  assert.deepEqual(result.deferred,['rsiReplay','migration.tsuzukiF7Verified']);
});

test('Core refuses missing, controlled, stale and incomplete native cross-provider proof', () => {
  for(const d of [null,
    {...nativeDelegation(),headSha:'e'.repeat(40)},
    {...nativeDelegation(),evidenceClass:'CONTROLLED_TEST'},
    {...nativeDelegation(),sourceProvider:'antigravity',targetProvider:'codex'},
    {...nativeDelegation(),facts:{...nativeDelegation().facts,artifactVerified:false}},
    {...nativeDelegation(),evidenceRefs:[]},
    {...nativeDelegation(),workflowState:'UNKNOWN'},
  ]) {
    const result=evaluateV2ReadinessProfile({profile:'CORE',expectedHeadSha:HEAD,expectedRuntimeImageId:IMAGE,evidence:evidence(),nativeDelegation:d});
    assert.equal(result.ready,false,JSON.stringify(d));
    assert.ok(result.missing.includes('nativeDelegation')||result.invalid.some(v=>v.startsWith('nativeDelegation:')));
  }
});

test('Core still requires AGY field, native Windows and generic migration', () => {
  for(const missing of ['antigravity','windows','migration']) {
    const e=evidence();
    if(missing==='antigravity')delete e.providers.antigravity;
    if(missing==='windows')delete e.platforms.windows;
    if(missing==='migration')delete e.migration;
    const result=evaluateV2ReadinessProfile({profile:'CORE',expectedHeadSha:HEAD,expectedRuntimeImageId:IMAGE,evidence:e,nativeDelegation:nativeDelegation()});
    assert.equal(result.ready,false);
    assert.ok(result.missing.some(v=>v.includes(missing)));
  }
});

test('unknown profile fails closed and Core checks the exact Runtime Image', () => {
  assert.throws(()=>evaluateV2ReadinessProfile({profile:'TRIAL',expectedHeadSha:HEAD,expectedRuntimeImageId:IMAGE,evidence:evidence()}),/profile/);
  assert.throws(()=>evaluateV2ReadinessProfile({profile:'CORE',expectedHeadSha:HEAD,expectedRuntimeImageId:'sha256:wrong',evidence:evidence(),nativeDelegation:nativeDelegation()}),/expectedRuntimeImageId/);
  const result=evaluateV2ReadinessProfile({profile:'CORE',expectedHeadSha:HEAD,expectedRuntimeImageId:`sha256:${'e'.repeat(64)}`,evidence:evidence(),nativeDelegation:nativeDelegation()});
  assert.equal(result.ready,false);
  assert.ok(result.invalid.includes('nativeDelegation:runtimeImageId'));
});
