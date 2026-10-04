import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDevPlan } from './dev-local.mjs';

test('laptop npm run dev starts the API and Vite so localhost:3000 is not empty', () => {
  assert.deepEqual(resolveDevPlan({}).processes, ['api', 'ui']);
  assert.deepEqual(resolveDevPlan({ NODE_ENV: 'development' }).processes, ['api', 'ui']);
});

test('Docker web keeps Vite-only because the API lives in the sibling container', () => {
  assert.deepEqual(resolveDevPlan({ API_PROXY_TARGET: 'http://api:3001' }).processes, ['ui']);
});
