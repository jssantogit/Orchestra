import { createDelegationBroker as createBroker } from '../../runtime/delegation/broker.mjs';
import { executeParallelImplementationGroup as executeGroup } from '../../runtime/delegation/parallel-broker.mjs';
import { runBoundedProcess as runProcess } from '../../runtime/delegation/process-runner.mjs';

export const createDelegationBroker = (options) => createBroker({ resourceGovernor: testResourceGovernor(), ...options });
export const executeParallelImplementationGroup = (options, services) => executeGroup({ resourceGovernor: testResourceGovernor(), ...options }, services);
export const runBoundedProcess = (options) => runProcess({ resourceGovernor: testResourceGovernor(), ...options });

export function testResourceGovernor() {
  return {
    reserve() { return { ok: true, leaseId: 'deterministic-unit-test-only' }; },
    recheck() { return { ok: true }; },
    release() { return { ok: true }; },
  };
}
