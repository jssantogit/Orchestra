import { createResourceGovernor } from '../../runtime/resources/governor.mjs';
const GiB = 1024 ** 3;
const governor = createResourceGovernor({ home: process.argv[2], sample: () => ({ verified: true, effectiveBytes: 4 * GiB, availableBytes: 3 * GiB, commitAvailableBytes: 3 * GiB }) });
console.log(JSON.stringify(governor.reserve({ projectRef: process.argv[3], bytes: 1.5 * GiB })));
