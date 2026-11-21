import base from './vitest.config.js';
export default { ...base, test: { ...base.test, globalSetup: [], include: ['tests/task-workflow-guards.test.ts', 'tests/migration-guard.test.ts'] } };
