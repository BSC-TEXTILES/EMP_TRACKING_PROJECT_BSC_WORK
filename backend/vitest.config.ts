import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    // The suite performs many sign-ins from one loopback address; the production
    // login limiter would otherwise throttle later tests. Account lockout and
    // rate-limit behaviour are exercised separately.
    env: { NODE_ENV: 'test', EMAIL_SENDING_ENABLED: 'true', WEB_SETUP_ENABLED: 'false', LOGIN_RATE_LIMIT_MAX: '200', ALLOW_UNSCANNED_UPLOADS: 'true' },
  },
});
