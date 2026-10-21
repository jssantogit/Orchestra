import test from 'node:test';
if (Number(process.versions.node.split('.')[0]) >= 24) {
  await import('./v2-native-execution-routing.cases.mjs');
} else {
  test('native Work execution requires Node 24 Home persistence', {skip:true},()=>{});
}
