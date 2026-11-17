import base from './vitest.config.js';
export default { ...base, test: { ...base.test, globalSetup: [], include: ['tests/activity-boundaries.test.ts'] } };
