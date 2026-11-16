// Always produce a production bundle, even when the host (e.g. Hostinger's
// build runner) exports NODE_ENV=development. Without this, Vite emits a dev
// build (jsxDEV, import.meta.env.DEV === true) and dev-only API calls ship.
process.env.NODE_ENV = 'production';

const { build } = await import('vite');
await build({ mode: 'production' });
